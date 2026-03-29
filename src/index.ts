import moment from "moment"
import { inspect } from "node:util"
import { createWriteStream, WriteStream } from "node:fs"
import { InitParams, CommandGenerator, DialogHandler, CommandGeneratorResult, DialogHandlerResult, DialogResult, Point2D } from "../types/main"
import assert from "node:assert"
import { isAsyncFunction, isGeneratorFunction } from "node:util/types"

enum Sequence {
	Beep = '\x07'
}

const defaultDialogs: Record<string, DialogHandler> = {
	'confirm': async (input) => {
		let success = false
		input = input.toLowerCase().trim()
		if (input == 'y' || input == 'yes') {
			input = 'y'
			success = true
		} else if (input == 'n' || input == 'no') {
			input = 'n'
			success = true
		}
		return {
			success,
			value: input == 'y'
		}
	},
	'textinput': async (input) => {
		return {
			success: true,
			value: input.trim()
		}
	}
}

const colorSequenceRegex = /((?:\x1B\[\d+m)|(?:\x1B\[(?:38|48);2;\d+;\d+;\d+m))/g
export class Terminal {
	private _config: Required<InitParams> = {
		tabSize: 8,
		linesPerScroll: 3,
		maxContentBufferSize: 8192,
		maxCommandHistorySize: 64,
		exportDir: null,
		inputRegex: /^[\x20-\x7E]$/,
		inputEnabled: true
	}
	private _size: Point2D = {x: -1, y: -1}
	private _commands: Record<string, CommandGenerator> = {}
	private _inputBuffer: Array<string> = []
	private _content: Array<string> = []
	private _commandHistory: Array<string> = []
	private _scrollOffset = 0
	private _lineOffset = 0
	private _inputCursor = 1
	private _scrollMax = 0
	private _currentCommandFromHistory = 1
	private _exportStream: WriteStream | undefined
	private _suggestedCommandTrail: string | undefined
	private _currentRunningCommand: {
		name?: string,
		generator?: ReturnType<CommandGenerator> | undefined,
		handlerName?: string | undefined,
		dialogHandler?: DialogHandler | undefined,
		handlerInAction: boolean
	} = {
		handlerInAction: false
	}

	private _dialogHandlers: Record<string, DialogHandler> = {}

	/** Sequence to reset color formatting */
	public static resetColorSeq = `\x1B[0m` as const
	/** Prebuilt color sequences. Used in output color tag parsing */
	public static colors: Record<string, string> = {
		// normal colors
		red: Terminal.RGBSeq(200, 50, 50),
		orange: Terminal.RGBSeq(200, 150, 50),
		yellow: Terminal.RGBSeq(200, 200, 50),
		green: Terminal.RGBSeq(50, 200, 50),
		cyan: Terminal.RGBSeq(50, 153, 153),
		blue: Terminal.RGBSeq(11, 97, 164),
		purple: Terminal.RGBSeq(166, 50, 166),
		white: Terminal.RGBSeq(204, 204, 204), //aka #CCC (default white cmd text color)

		// light colors
		lorange: Terminal.RGBSeq(200, 192, 150),
		lred: Terminal.RGBSeq(200, 150, 150),
		lgreen: Terminal.RGBSeq(150, 200, 150),

		// dark colors
		dwhite: Terminal.RGBSeq(135, 135, 135)
	}

	private async _onCommandPause(data: CommandGeneratorResult) {
		if (typeof data == 'object') {
			// return reached
			if (data.done) {
				// no chain
				this._currentRunningCommand = { handlerInAction: false } // this._currentRunningCommand.name
				if (!data.value) {
					return
				}

				// next command, no args
				if (typeof data.value == 'string') {
					if (!this._commands[data.value]) {
						this.error(`Failed to redirct command from #r'${this._currentRunningCommand.name}'#R to #r'${data.value}'#R: unknown target command`)
						return
					}
					this._currentRunningCommand.name = data.value,
					this._currentRunningCommand.generator = this._commands[data.value]()
					this._currentRunningCommand.generator.next().then(this._onCommandPause.bind(this))
					return
				}

				// next command, args present
				if (!this._commands[data.value.name]) {
					this.error(`Failed to redirct command from #r'${this._currentRunningCommand.name}'#R to #r'${data.value.name}'#R: unknown target command`)
					return
				}
				this._currentRunningCommand.name = data.value.name,
				this._currentRunningCommand.generator = this._commands[data.value.name](...(data.value.args))
				this._currentRunningCommand.generator.next().then(this._onCommandPause.bind(this))
				return
			}

			// yield reached
			if (!this._dialogHandlers[data.value]) {
				this._currentRunningCommand.generator!.throw(new Error(`Dialog '${data.value}' doesnt exist`)).then(this._onCommandPause)
				return
			}
			this._currentRunningCommand.handlerName = data.value
		}
	}

	private _onDialogInteraction(handler: DialogHandler, result: DialogHandlerResult) {
		if (this._currentRunningCommand.dialogHandler !== handler) { 
			return 
		}
		this._currentRunningCommand.handlerInAction = false
		if (result.success) {
			delete this._currentRunningCommand.dialogHandler
			this._currentRunningCommand.generator!.next({
				value: result.value,
				interrupted: false
			}).then(this._onCommandPause.bind(this))
			return
		}
	}

	private _calcScrollMax() {
		let i = this._content.length-1
		let vsize = 0
		let lastLineAmount = 0
		while (vsize < this._size.y && i > 0) {
			lastLineAmount = this._parseActualContent(i--).length
			vsize += lastLineAmount
		}
		this._scrollMax = Math.max(0, i - Number(vsize > this.size.y))
	}

	constructor(params?: InitParams) {
		this._config = { ...this._config, ...params }

		assert(typeof this._config.tabSize == 'number') 
		assert(this._config.tabSize > 0)

		assert(typeof this._config.maxContentBufferSize == 'number')
		assert(this._config.maxContentBufferSize >= 128)
		assert(this._config.maxContentBufferSize < 65536)

		assert(typeof this._config.maxCommandHistorySize == 'number')
		assert(this._config.maxCommandHistorySize > 0)
		assert(this._config.maxCommandHistorySize < 65536)

		assert(typeof this._config.linesPerScroll == 'number' )
		assert(this._config.linesPerScroll > 0)
		assert(this._config.linesPerScroll <= 16)
		
		assert(typeof this._config.inputRegex == 'object')
		assert(this._config.inputRegex instanceof RegExp)
		assert(typeof this._config.inputEnabled == 'boolean')
		//if (this._config.tabSize < 0)

		if (this._config.inputEnabled) {
			this._size = {
				x: process.stdout.columns,
				y: process.stdout.rows-1
			}
			process.stdout.prependListener('resize', () => {
				this._size = {
					x: process.stdout.columns,
					y: process.stdout.rows-1
				}
				this._calcScrollMax()
				this._render()
			})

			process.stdout.write(`\x1B[${process.stdout.rows};${process.stdout.columns}H\x1B[1J\x1B[${process.stdout.rows};1H> \x1B[1;1H\x1b[?1000h`)
			process.stdin.setRawMode(true).resume()
			process.stdin.on("data", key => {
				// ctrl+c: terminate
				if (key == '\x03') {
					process.exit()
				}
				// ctrl+d: end of transmission
				else if (key == '\x04') {
					// command cannot be safely interrupted 
					//if (this._currentRunningCommand.name != undefined) {
					if (this._currentRunningCommand.handlerName) {
						delete this._currentRunningCommand.dialogHandler
						delete this._currentRunningCommand.handlerName
						this._currentRunningCommand.handlerInAction = false
						this._currentRunningCommand.generator!.next({
							value: null,
							interrupted: true
						}).then(this._onCommandPause.bind(this))
						return
					}
					// this.writeln('-> Command interrupted')
					// this._currentRunningCommand.generator!.throw('Interrupt')
					// this._currentRunningCommand = { handlerInAction: false } // this._currentRunningCommand.name
					//}
				}
				// mouse scroll
				else if (key.toString().startsWith('\x1B[M')) {
					let delta = (key.toString().charCodeAt(3) - 32) & 3
					let actualContent = this._parseActualContent(this._scrollOffset)
					let linesRemaining = this._config.linesPerScroll

					// down
					if (delta == 1) {
						if (this._lineOffset == actualContent.length-1 && this._scrollOffset == this._scrollMax) 
							return

						while (linesRemaining != 0) {
							let lineDelta = Math.min(this._config.linesPerScroll, actualContent.length - 1 - this._lineOffset)
							if (lineDelta > 0) {
								this._lineOffset += lineDelta
								linesRemaining -= Math.min(linesRemaining, lineDelta)
								continue
							}
							if (this._scrollOffset + 1 <= this._scrollMax) {
								this._lineOffset = 0
								this._scrollOffset++
								linesRemaining--
								continue
							}
							break
						}
					// up
					} else if (delta == 0) {
						if (this._lineOffset == 0 && this._scrollOffset == 0) 
							return

						while (linesRemaining != 0) {
							let lineDelta = Math.min(this._config.linesPerScroll, this._lineOffset)
							if (lineDelta > 0) {
								this._lineOffset -= lineDelta
								linesRemaining -= Math.min(linesRemaining, lineDelta)
								continue
							}
							if (this._scrollOffset > 0) {
								this._lineOffset = this._parseActualContent(--this._scrollOffset).length - 1
								linesRemaining--
								continue
							}
							break
						}
						
						// if (this._lineOffset-1 < 0) {
						// 	actualContent = this._parseActualContent(--this._scrollOffset)
						// 	this._lineOffset = actualContent.length-1
						// } else {
						// 	this._lineOffset -= 1
						// }
					}
				}
				// arrow right 
				else if (key == '\x1B[C') {
					this._inputCursor = Math.min(this._inputBuffer.length + 1, this._inputCursor+1)
				}
				// arrow left
				else if (key == '\x1B[D') {
					this._inputCursor = Math.max(1, this._inputCursor-1)
				}
				// delete
				else if (key == '\x1B[3~') {
					if (this._inputCursor == this._inputBuffer.length + 1) return
					this._inputBuffer.splice(this._inputCursor-1, 1)
					if (this._inputBuffer.length == 0) {
						this._currentCommandFromHistory = this._commandHistory.length
					}
				}
				// backspace 
				else if (key == '\x7F' || key == '\x08') {
					if (this._inputCursor == 1) {
						return
					}
					this._inputCursor = Math.max(0, this._inputCursor-1)
					this._inputBuffer.splice(this._inputCursor-1, 1)
					if (this._inputBuffer.length == 0) {
						this._currentCommandFromHistory = this._commandHistory.length
					}
				}
				// enter
				else if (key == '\r') {
					if (this._inputBuffer.length > 0 || (this._currentRunningCommand.handlerName && !this._currentRunningCommand.handlerInAction)) {
						let input = this._inputBuffer.join('')	
						this._inputBuffer.splice(0)
						this._inputCursor = 1
						this._currentCommandFromHistory = this._commandHistory.length

						if (this._currentRunningCommand.handlerName) {
							this._currentRunningCommand.handlerInAction = true
							this._currentRunningCommand.dialogHandler = this._dialogHandlers[this._currentRunningCommand.handlerName]
							this._currentRunningCommand.dialogHandler(input)
								.then(this._onDialogInteraction.bind(this, this._currentRunningCommand.dialogHandler))
							this._render()
							return
						}

						let [cmd, ...args] = input.split(" ")
						args = args.filter(item => item != '')
						if (this._commands[cmd] == undefined) {
							this.writeln(`#lred;-> Unknown command: '#r${cmd}#lred;'`)
							this._render()
							return
						}
						
						this._currentRunningCommand.name = cmd
						this._currentRunningCommand.generator = this._commands[cmd](...args)
						this._currentRunningCommand.generator.next().then(this._onCommandPause.bind(this))
						
						let historyIndex = this._commandHistory.indexOf(cmd)
						if (historyIndex != -1) 
							this._commandHistory.splice(historyIndex, 1)
						this._commandHistory.push(cmd + ' ' + args.join(' '))
					}
				}
				// tab
				else if (key == '\t') {
					if (!this._suggestedCommandTrail) return
					this._inputBuffer.push(...this._suggestedCommandTrail)
					this._inputCursor = this._inputBuffer.length + 1
				}

				// arrow up
				else if (key == '\x1B[A') {
					if (this._commandHistory.length == 0 || this._currentCommandFromHistory == 0) {
						process.stdout.write(Sequence.Beep)
						return
					}
					this._inputBuffer.splice(0)
					this._inputBuffer.push(...this._commandHistory[--this._currentCommandFromHistory])
					this._inputCursor = this._inputBuffer.length + 1
				}
				// arrow down
				else if (key == '\x1B[B') {
					if (this._commandHistory.length == 0 || this._currentCommandFromHistory >= this._commandHistory.length - 1) {
						process.stdout.write(Sequence.Beep)
						return
					}
					this._inputBuffer.splice(0)
					this._inputBuffer.push(...this._commandHistory[++this._currentCommandFromHistory])
					this._inputCursor = this._inputBuffer.length
				}
				else if (this._currentRunningCommand.handlerInAction) 
					return
				else if ((!this._currentRunningCommand.name || (this._currentRunningCommand.handlerName && !this._currentRunningCommand.handlerInAction)) && /[\x20-\x7E]/.test(key.toString())) {
					this._inputBuffer.splice(this._inputCursor++ - 1, 0, key.toString())
				}
				
				let input = this._inputBuffer.join('')
				let [cmd] = input.split(" ")
				this._suggestedCommandTrail = undefined

				if (input.length > 0 && !this._commands[cmd]) {
					let suggested = Object.keys(this._commands).sort().find(item => item.startsWith(input))
					if (suggested) 
						this._suggestedCommandTrail = suggested.replace(cmd, '')
				}
				this._render()
			})
			process.on('exit', code => {
				process.stdin.read()
				process.stdin.setRawMode(false).resume()
				process.stdout.write(`\x1b[?1000l\x1B[${process.stdout.rows};${process.stdout.columns}H\x1B[1J\x1B[1;1H`) // caret, scroll, clear
				this._exportStream?.close()
				console.log(`[Terminated: ${code}]`)
			})

			for (const [dialogName, handler] of Object.entries(defaultDialogs)) {
				this.registerDialog(dialogName, handler)
			}
		} else {
			process.on('exit', code => {
				console.log(`[Terminated: ${code}]`)
			})
		}

		if (this._config.exportDir == null) {
			//this.warn('No log export directory set. Log export will not be performed.')
			return
		} 
		this._exportStream = createWriteStream(this._config.exportDir)
	}

	//#region static: private
	private static _getStringLength(text: string) {
		colorSequenceRegex.lastIndex = 0
		return text.replaceAll(colorSequenceRegex, '').length
	}

	private static _cutFormatString(match: string, needle: string, fmt: string) {
		return fmt + match.replace(needle, "")	
	}

	//#endregion

	//#region static: public
	/** Returns stdout sequence for specified text color. All arguments should be `[0; 255]` */
	public static RGBSeq(r?: number, g?: number, b?: number): string {
		return r == undefined ? `\x1B[0m` : `\x1B[38;2;${r};${g ?? 255};${b ?? 255}m`
	}

	/** Replaces all color tags with their sequences */
	public static formatSeq(msg: string) {
		const colorsKeys = Object.keys(Terminal.colors)

		return msg.replaceAll(/#\/?\w+;?/g, match => {
			const separatorIndex = match.indexOf(';')
			const cmd = separatorIndex > 0 ? match.substring(1, separatorIndex) : match[1]
			const cmdRaw = separatorIndex > 0 ? match.substring(0, separatorIndex+1) : match.substring(0, 2)

			if (Terminal.colors[cmd]) return Terminal._cutFormatString(match, cmdRaw, Terminal.colors[cmd])
			if (cmd == 'R') return Terminal._cutFormatString(match, cmdRaw, Terminal.resetColorSeq)

			let needleColor = colorsKeys.find(item => item.substring(0, cmd.length) == cmd)
			if (needleColor) return Terminal._cutFormatString(match, cmdRaw, Terminal.colors[needleColor])
			return match
		})
	}

	/** 
	 * Returns array of callstack. `function` will be `undefined` for anonymous functions 
	 * */
	public static stackTrace() {
		let stack = new Error().stack
		if (!stack)
			return []
		let res = []

		for (const obj of stack.matchAll(/at\s+([\w<>\.-]+)\s+\((.+)\)/g)) {
			let [fileName, line] = obj[2].substring(obj[2].lastIndexOf('\\') + 1).split(':')
			res.push({
				function: obj[1] == "<anonymous>" ? undefined : obj[1],
				line: Number(line), 
				file: fileName.substring(0, fileName.lastIndexOf('.'))
			})
		}
		return res
	}
	//#endregion

	//#region private
	private _split(text: string) {
		let res = []
		while (true) {
			let textLen = Terminal._getStringLength(text)
			if (textLen < this._size.x) 
				break
			
			let sliceEndIndex = this._size.x
			let excludedLength = 0
			colorSequenceRegex.lastIndex = 0
			while (colorSequenceRegex.lastIndex - excludedLength < this._size.x) {
				let matches = colorSequenceRegex.exec(text)

				if (!matches || matches.length == 0) 
					break

				if (matches.length > 0 && colorSequenceRegex.lastIndex - excludedLength - matches[0].length < this._size.x) {
					sliceEndIndex += matches[0].length
					excludedLength += matches[0].length
				}
			}

			let piece = text.slice(0, sliceEndIndex)
			// let purePiece = piece.replaceAll(colorSequenceRegex, '')
			// let purePieceNoNL = purePiece.replaceAll('\n', '')
			// if (res.length > 0 && purePiece.length != purePieceNoNL.length && purePieceNoNL.length == 0) {
			// 	res[res.length - 1] += piece
			// 	sliceEndIndex += piece.length
			// } else {
			// 	res.push(piece)
			// }
			res.push(piece)

			// apply last applied color for new line, if there is remaining content
			let sequenceMatch = res[res.length - 1].match(colorSequenceRegex)
			let remainingText = text.slice(sliceEndIndex)
			text = sequenceMatch && remainingText.length > 0 
				? (sequenceMatch[sequenceMatch.length - 1] + remainingText)
				//? ('|' + res[res.length - 1] + '|' + remainingText)
				: remainingText
		}
		res.push(text)
		if (res[res.length - 1] == '') res.pop()
		return res
	}

	private _parseActualContent(line: number) {
		let tabPieces = this._content[line].split('\t')
		let actualContent = [tabPieces[0]]
		if (tabPieces.length == 1) {
			actualContent.push(...this._split(actualContent.pop()!))
		}	

		for (let i = 1; i < tabPieces.length; i++) {
			let lastLine = actualContent[actualContent.length - 1]
			let lineLength = Terminal._getStringLength(lastLine)
			let extraSpaces = this._config.tabSize - lineLength % this._config.tabSize

			if (lineLength + extraSpaces > this._size.x)
				extraSpaces = Math.max(0, this._size.x - lineLength - 1)

			lastLine += ' '.repeat(extraSpaces) + tabPieces[i]

			if (Terminal._getStringLength(lastLine) > this._size.x) {
				actualContent.pop()
				actualContent.push(...this._split(lastLine))
				continue
			}

			actualContent[actualContent.length - 1] = lastLine
		}
		
		return actualContent.map(ln => ln.replaceAll('\n', '') + ' '.repeat(Math.max(0, this._size.x - Terminal._getStringLength(ln))))
	}

	private _render() {
		let str = `\x1B[${process.stdout.rows};${process.stdout.columns}H\x1B[1J\x1B[1;1H` // clear screen, reset cursor position 
		let actualSize = 0
		for (let contentLine = this._scrollOffset; contentLine < this._content.length && actualSize < this._size.y; contentLine++) {
			let parsedLines = this._parseActualContent(contentLine)
			if (contentLine == this._scrollOffset)
				parsedLines.splice(0, this._lineOffset)
			
			for (let contentSubline = 0; contentSubline < Math.min(parsedLines.length, this._size.y - actualSize + 1); contentSubline++) {
				str += `\x1B[${++actualSize};1H${parsedLines[contentSubline]}`
			}
		}
		str += `\x1B[${process.stdout.rows};1H\x1B[2K` // clear previous input
		str += `\x1B[${process.stdout.rows};1H${Terminal.colors.white}> ${this._inputBuffer.join('')}` // apply current input
		if (this._suggestedCommandTrail)
			str += `${Terminal.RGBSeq(100,100,100)}${this._suggestedCommandTrail}${Terminal.resetColorSeq}`
		str += `\x1B[${process.stdout.rows};${2 + this._inputCursor}H`
		process.stdout.write(str) // roll out
	}

	private _parseWriteArgs(args: Array<any>) {
		return args.map(arg => typeof arg != "string" ? inspect(arg, {colors: true}) : arg).join(" ")
	}
	//#endregion

	//#region public
	/** Current size of terminal window. Always will be `(-1; -1)` if `inputEnabled` is set to `false` */
	public get size() {
		return {...this._size}
	}

	/** Clears output history */
	public clear() {
		process.stdout.write(`\x1B[1;1H\x1B[1J\x1B[1;1H`)
		this._lineOffset = this._scrollOffset = 0
		this._content.splice(0)
		this._render()
	}

	/** Logs data **without** color reset and `\n`, calls nodejs `inspect` before logging */
	public write(...args: any[]) {
		let data = Terminal.formatSeq(this._parseWriteArgs(args))
		let content = data.replaceAll(colorSequenceRegex, '')
		
		if (this._exportStream && content.length > 0) {
			try {
				this._exportStream.write(content)
			} catch {}
		}

		if (!this._config.inputEnabled) {
			process.stdout.write(data)
			return
		}
		
		let lines = data.split('\n')
		let autoScrollDown = this._scrollOffset == this._scrollMax

		if (this._content.length > 0 && !this._content[this._content.length - 1].endsWith('\n'))
			this._content[this._content.length - 1] += lines.shift()

		if (lines.length > 0) {
			for (let line = 0; line < lines.length - 1; line++) {
				const regex = new RegExp(`(${colorSequenceRegex.source})(?!.*(?:${colorSequenceRegex.source}))$`) // /(\x1B\[\d+m)|(\x1B\[(38|48);2;\d+;\d+;\d+m)(?!.*\x1B\[\d+m)|(\x1B\[(38|48);2;\d+;\d+;\d+m)/g
				let matches = regex.exec(lines[line])
				if (!matches || matches.length == 0)
					continue
				let lastMatch = matches.filter(item => item != undefined).pop()!
				lines[line] = lines[line].substring(0, matches.index /*- lastMatch.length*/)
				lines[line + 1] = lastMatch + lines[line + 1]
			}
			this._content.push(...lines)
		}
		
		if (Terminal._getStringLength(this._content[this._content.length - 1]) == 0) {
			this._content[this._content.length - 2] = this._content[this._content.length - 2] + this._content.pop()!
		}

		if (content.endsWith('\n')) this._content[this._content.length - 1] += '\n'

		if (this._content.length > this._config.maxContentBufferSize) {
			let delta = this._content.length - this._config.maxContentBufferSize
			let oldOffset = this._scrollOffset

			this._content.splice(0, delta)
			this._scrollOffset = Math.max(0, oldOffset - delta)

			if (oldOffset - delta < 0) {
				this._lineOffset = this._parseActualContent(this._scrollOffset).length - 1
			}
		}

		this._calcScrollMax()

		if (autoScrollDown) {
			//this._scrollOffset = Math.max(0, Math.min(this._scrollMax, this._content.length-1))
			this._scrollOffset = Math.min(this._content.length - 1, Math.max(0, this._scrollMax));
			this._lineOffset = this._parseActualContent(this._scrollOffset).length - 1
		}

		this._render()
	}

	/** Logs data **with** color reset and `\n`, calls `.write()` */
	public writeln(...args: any[]) {
		this.write(this._parseWriteArgs(args) + '#R\n')
		//this.write()
	}

	/** 
	 * Logs data **with** color reset and `\n` in `[HH:MM:SS] [FILE:LINE] [Log] {content}` format(gray/white colors)\
	 * Calls `.write()`
	 **/
	public log(...args: any[]) {
		let data = this._parseWriteArgs(args)
		const stack = Terminal.stackTrace()
		//this.writeln(stack)
		this.writeln(`${Terminal.RGBSeq(135, 135, 135)}[${moment().format("HH:mm:ss")}] [${stack[2].file}:${stack[2].line}] #R[Log] ${data}`)
	}

	/** 
	 * Logs data **with** color reset and `\n` in `[HH:MM:SS] [FILE:LINE] [Warn] {content}` format(dark orange/pastel yellow colors)\
	 * `#R` tag will use pastel yellow color\
	 * Calls `.write()`
	 **/
	public warn(...args: any[]) {
		let data = this._parseWriteArgs(args)
		const lo = Terminal.RGBSeq(200, 192, 150)
		const stack = Terminal.stackTrace()
		data = data.replaceAll(/(\#[wR])/g, lo)
		this.writeln(`${Terminal.RGBSeq(140, 105, 35)}[${moment().format("HH:mm:ss")}] [${stack[2].file}:${stack[2].line}] ${lo}[#oWarning${lo}] ${data}`)
	}

	/** 
	 * Logs data **with** color reset and `\n` in `[HH:MM:SS] [FILE:LINE] [Error] {content}` format(dark red/pastel red colors)\
	 * `#R` tag will use pastel red color\
	 * Calls `.write()` 
	 **/
	public error(data: string, error?: Error) {
		const lr = Terminal.RGBSeq(200, 150, 150)
		const stack = Terminal.stackTrace()
		data = data.replaceAll(/(\#[wR])/g, lr) // match #w and #R (override white color to light red)
		this.writeln(`${Terminal.RGBSeq(140, 35, 35)}[${moment().format("HH:mm:ss")}] [${stack[2].file}:${stack[2].line}] ${lr}[#rError${lr}] ${data}`)
		if (error) this.writeln(inspect(error))
	}

	/** 
	 * Logs data **with** color reset and `\n` in `[HH:MM:SS] [FILE:LINE] [Success] {content}` format(dark green/pastel green colors)\
	 * `#R` tag will use pastel green color\
	 * Calls `.write()` 
	 **/
	public success(...args: any[]) {
		let data = this._parseWriteArgs(args)
		const lg = Terminal.RGBSeq(150, 200, 150)
		const stack = Terminal.stackTrace()
		data = data.replaceAll(/(\#[wR])/g, lg)
		this.writeln(`${Terminal.RGBSeq(35, 140, 35)}[${moment().format("HH:mm:ss")}] [${stack[2].file}:${stack[2].line}] ${lg}[#gSuccess${lg}] ${data}`)
	}

	/** Writes in stdin special unprintable sequences */
	public applyOnetimeSequence(seq: Sequence) {
		process.stdout.write(seq)
	}

	/**
	 * Creates command with associated listener
	 * @throws If name contains whitespace characters, name is empty or listener is not async generator
	 */
	public registerCommand(command: string, listener: CommandGenerator) {
		assert(command.trim() != '', "Attempt to register an empty command")
		assert(command.match(/\s/g) == null, `Whitespaces in commands are not allowed`)
		assert(this._commands[command] == undefined, `Command '${command}' already exists`)
		assert(isAsyncFunction(listener) && isGeneratorFunction(listener), `Command executor must be an async generator function`)

		this._commands[command] = listener
	}

	/**
	 * Deletes specified command
	 * @throws If command doesnt exists
	 */
	public deleteCommand(command: string) {
		assert(this._commands[command] != undefined, `Command '${command}' does not exists`)

		delete this._commands[command]
	}

	/**
	 * Creates dialog with associated handler
	 * @throws If name contains whitespace characters, name is empty or handler is not async function
	 */
	public registerDialog(dialogName: string, handler: DialogHandler) {
		assert(dialogName.trim() != '', "Attempt to register an empty dialog")
		assert(this._commands[dialogName] == undefined, `Dialog '${dialogName}' already exists`)
		assert(typeof handler == "function" && isAsyncFunction(handler), `Command executor must be an async function`)

		if (dialogName.trim() == '')
			throw new Error(`Attempt to register empty dialog`)

		if (this._dialogHandlers[dialogName] != undefined)
			throw new Error(`Dialog '${dialogName}' already exists`)

		this._dialogHandlers[dialogName] = handler
	}

	/**
	 * Deletes specified command
	 * @throws If dialog doesnt exists
	 */
	public deleteDialog(dialogName: string) {
		if (this._dialogHandlers[dialogName] == undefined) 
			throw new Error(`Command '${dialogName}' does not exists`)

		delete this._dialogHandlers[dialogName]
	}
	//#endregion
}

// +-----------------+ //
// | USER CODE BELOW | //
// +-----------------+ //

//t.writeln(t._content[0].match(colorSequenceRegex))
//t.log("sdvfnjsdfvjknslkfdvnjksmac;dsaidsncjk amldsjvnfvnjjsbvlsf badjs l*")

// function bar(n: number) {
// 	t.log(Terminal.stackTrace())
// }

// function foo(n: number) {
// 	return bar(n)
// }

// ;(async function() {
// 	let i = 0
// 	while (true) {
// 		await new Promise(r => setTimeout(r, 1000))
// 		foo(i++)
// 	}
// })()


// const t = new Terminal()

// t.registerDialog("number input", async function(input) {
// 	if (/^[0-9]+$/.test(input)) {
// 		return {
// 			success: true, // Остановить ввод
// 			value: Number(input) // и передать значение в команду
// 		}
// 	}
// 	t.warn(`Invalid input '${input}'`)
// 	return {
// 		success: false, // Продолжить ввод, ничего не передавая
// 		value: null // <- Не используется, но обязательно. Впадлу пока исправлять
// 	}
// })

// t.registerCommand("test", async function*() {
// 	t.log("Running test command. Awaiting number input. Press Ctrl+D to interrupt")
// 	let n: DialogResult<number> = yield "number input" // Неявно any
// 	if (n.interrupted) {
// 		t.error("Input interrupted")
// 	} else {
// 		t.success(`Assuming input '#g${n.value}#R' as '#g${Boolean(n.value)}#R'`)
// 	}
// 	t.log("Test command finished")
// })

// for (let i = 0; i < 250; i++)
// 	t.log(`${Math.pow(i, 6)} ${Math.floor(Math.random() * 10) == 5 ? '\n' : '\t\t\t\t\t\t\t\t'} ${i}`)