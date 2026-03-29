import { InitParams, CommandGenerator, DialogHandler } from "../types/main";
declare enum Sequence {
    Beep = "\u0007"
}
export declare class Terminal {
    private _config;
    private _size;
    private _commands;
    private _inputBuffer;
    private _content;
    private _commandHistory;
    private _scrollOffset;
    private _lineOffset;
    private _inputCursor;
    private _scrollMax;
    private _currentCommandFromHistory;
    private _exportStream;
    private _suggestedCommandTrail;
    private _currentRunningCommand;
    private _dialogHandlers;
    /** Sequence to reset color formatting */
    static resetColorSeq: "\u001B[0m";
    /** Prebuilt color sequences. Used in output color tag parsing */
    static colors: Record<string, string>;
    private _onCommandPause;
    private _onDialogInteraction;
    private _calcScrollMax;
    constructor(params?: InitParams);
    private static _getStringLength;
    private static _cutFormatString;
    /** Returns stdout sequence for specified text color. All arguments should be `[0; 255]` */
    static RGBSeq(r?: number, g?: number, b?: number): string;
    /** Replaces all color tags with their sequences */
    static formatSeq(msg: string): string;
    /**
     * Returns array of callstack. `function` will be `undefined` for anonymous functions
     * */
    static stackTrace(): {
        function: string | undefined;
        line: number;
        file: string;
    }[];
    private _split;
    private _parseActualContent;
    private _render;
    private _parseWriteArgs;
    /** Current size of terminal window. Always will be `(-1; -1)` if `inputEnabled` is set to `false` */
    get size(): {
        x: number;
        y: number;
    };
    /** Clears output history */
    clear(): void;
    /** Logs data **without** color reset and `\n`, calls nodejs `inspect` before logging */
    write(...args: any[]): void;
    /** Logs data **with** color reset and `\n`, calls `.write()` */
    writeln(...args: any[]): void;
    /**
     * Logs data **with** color reset and `\n` in `[HH:MM:SS] [FILE:LINE] [Log] {content}` format(gray/white colors)\
     * Calls `.write()`
     **/
    log(...args: any[]): void;
    /**
     * Logs data **with** color reset and `\n` in `[HH:MM:SS] [FILE:LINE] [Warn] {content}` format(dark orange/pastel yellow colors)\
     * `#R` tag will use pastel yellow color\
     * Calls `.write()`
     **/
    warn(...args: any[]): void;
    /**
     * Logs data **with** color reset and `\n` in `[HH:MM:SS] [FILE:LINE] [Error] {content}` format(dark red/pastel red colors)\
     * `#R` tag will use pastel red color\
     * Calls `.write()`
     **/
    error(data: string, error?: Error): void;
    /**
     * Logs data **with** color reset and `\n` in `[HH:MM:SS] [FILE:LINE] [Success] {content}` format(dark green/pastel green colors)\
     * `#R` tag will use pastel green color\
     * Calls `.write()`
     **/
    success(...args: any[]): void;
    /** Writes in stdin special unprintable sequences */
    applyOnetimeSequence(seq: Sequence): void;
    /**
     * Creates command with associated listener
     * @throws If name contains whitespace characters, name is empty or listener is not async generator
     */
    registerCommand(command: string, listener: CommandGenerator): void;
    /**
     * Deletes specified command
     * @throws If command doesnt exists
     */
    deleteCommand(command: string): void;
    /**
     * Creates dialog with associated handler
     * @throws If name contains whitespace characters, name is empty or handler is not async function
     */
    registerDialog(dialogName: string, handler: DialogHandler): void;
    /**
     * Deletes specified command
     * @throws If dialog doesnt exists
     */
    deleteDialog(dialogName: string): void;
}
export {};
