import { PathLike } from "node:fs"

export type Point2D = {
	x: number,
	y: number
}

/**
 * Result of dialog
 */
export type DialogHandlerResult = {
	/**
	 * Should dialog be finished(`true`) or retry input needed(`false`)
	 */
	success: boolean,
	/**
	 * Value to return. Will be ignored, if `success = false`
	 */
	value: any
}

/**
 * Dialog async handler. This funtion will be called after user input. `Ctrl+D` will not start dialog handler\
 * `await` will throttle input until handler execution end
 * @param input User input. Always non-empty string
 * @returns Object describing dialog result
 */
export type DialogHandler = (input: string) => Promise<DialogHandlerResult>

/**
 * `yield` result inside of command listener
 */
export type DialogResult<T = any> = {
	/**
	 * Indicates if `Ctrl+D` was pressed. If `true` - value is always `undefined`
	 */
	interrupted: boolean,
	/**
	 * Dialog result
	 */
	value: T
}

/**
 * Next command descriptor if you want to use next command with arguments
 */
export type CommandNextChain = {
	name: string,
	args: Array<string>
}

/**
 * Command listener(async generator)\
 * Input will be throttled until listener execution end(incl. `await`). `Ctrl+C` will terminate entire program\
 * \
 * Use `yield` to initialize prompt interaction(dialog)\
 * Use `Terminal.registerDialog` to create dialogs
 * @param arguments Command prompt arguments or arguments passed in `CommandNextChain`
 * @returns `string` - next command name to execute without running prompt command\
 * `CommandNextChain` - next command name with arguments to execute without running prompt command 
 * @see CommandNextChain For next command chaining details
 * @throws If dialog doesnt exists, command already exists, or command contains whitespaces
 */
export type CommandGenerator = (...arguments: string[]) => AsyncGenerator<
	string, // yield init 
	CommandNextChain | string | void, // final return
	DialogResult // yield result
>

export type CommandGeneratorResult = IteratorResult<string, CommandNextChain | string | void>

/**
 * Configuration for initializing `Terminal` class
 */
export type InitParams = {
	/**
	 * Max stored lines amount. Must be `[128; 65535]`\
	 * In case overflowing - oldest lines will be removed (doesnt apply to log file)\
	 * Buffer will be disabled if `inputEnabled` is set to `false`
	 * @default 8192
	 */
	maxContentBufferSize?: number,

	/**
	 * Width of `\t` (in spaces). Must be >0. Using too big numbers(compared to possible width) may lead to unexpected behaviour\
	 * This parameter will be ignored if `inputEnabled` is set to `false`
	 * @default 8
	 */
	tabSize?: number,

	/**
	 * Path to file for stored logs excluding colors, appends existing file if exists\
	 * Uses `WriteStream` which means file is autosaving automatically
	 * @default null
	 */
	exportDir?: PathLike | null,

	/**
	 * Max stored executed commands amount(including arguments and invalid commands). Must be [0; 65535]
	 * @default 64
	 */
	maxCommandHistorySize?: number,

	/**
	 * Lines amount per 1 mouse scroll trigger. Must be [1; 16]\
	 * This parameter will be ignored if `inputEnabled` is set to `false`
	 * @default 3
	 */
	linesPerScroll?: number,

	/**
	 * Input validator. Allows symbol input if it passes regex.\
	 * Doesnt apply to predefined control symbols such as `\x03` (Ctrl+C)
	 * @default /^[\x20-\x7E]$/
	 */
	inputRegex?: RegExp

	/**
	 * Toggles input feature\
	 * `false`: **default** stdin/stdout handlers will be used(raw mode), program will be terminated once ended or `Ctrl+C` or `process.exit()`\
	 * `true`: **custom** stdin/stdout handlers will be used, program will **not** be terminated until `Ctrl+C` or `process.exit()`
	 * @default true
	 */
	inputEnabled?: boolean
}