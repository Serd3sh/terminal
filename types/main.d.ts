import { PathLike } from "node:fs"

export type Point2D = {
	x: number,
	y: number
}

export type CommandNextChain = {
	name: string,
	args: Array<any>
}

export type DialogHandlerResult = {
	success: boolean,
	value: any
}
export type DialogHandler = (input: string) => Promise<DialogHandlerResult>

export type CommandDialogResponseItem = {
	value: any,
	interrupted: boolean
}

export type DialogResult<T = any> = {
	interrupted: boolean,
	value: T
}
export type CommandGenerator = (...any: string[]) => AsyncGenerator<
	string, // yield init 
	CommandNextChain | string | void, // final return
	DialogResult // yield result
>

export type CommandGeneratorResult = IteratorResult<string, CommandNextChain | string | void>

export type Events = {
	"command execute": [input: string, ...args: Array<string>]
}

export type InitParams = {
	/**
	 * Max stored lines amount. Must be `[128; 65535]`
	 * In case overflowing - oldest lines will be removed (doesnt apply to log file)
	 * @default 8192
	 */
	maxContentBufferSize?: number,
	/**
	 * Width of `\t` (in spaces). Must be >0. Using too big numbers(compared to possible width) may lead to unexpected behaviour
	 * @default 8
	 */
	tabSize?: number,
	/**
	 * Path to file for stored logs excluding colors
	 * Uses `WriteStream` which means file is autosaving automatically
	 * Appends existing file if exists
	 * @default null
	 */
	exportDir?: PathLike | null,
	/**
	 * Max stored runned commands amount(including arguments and invalid commands). Must be [0; 65535]
	 * @default 64
	 */
	maxCommandHistorySize?: number,
	/**
	 * Lines amount per 1 mouse scroll trigger. Must be [1; 16]
	 * @default 3
	 */
	linesPerScroll?: number,
	/**
	 * Input validator. Allows symbol input if it passes regex. 
	 * Doesnt apply to predefined control symbols such as `\x03` (Ctrl+C)
	 * @default /[\x20-\x7E]/
	 */
	inputRegex?: RegExp
}