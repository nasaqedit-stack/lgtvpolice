declare module 'fluent-ffmpeg' {
  interface FfmpegCommand {
    videoCodec(codec: string): this;
    audioCodec(codec: string): this;
    outputOptions(options: string | string[]): this;
    on(event: 'end', callback: () => void): this;
    on(event: 'error', callback: (err: Error) => void): this;
    save(path: string): this;
    seekInput(time: number): this;
    frames(count: number): this;
  }
  function ffmpeg(path: string): FfmpegCommand;
  function ffprobe(path: string, callback: (err: Error | null, data: any) => void): void;
  export = ffmpeg;
  export { ffprobe };
}