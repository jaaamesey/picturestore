declare module "linebreak" {
  export default class LineBreaker {
    constructor(text: string);
    nextBreak(): { position: number; required: boolean } | null;
  }
}

declare module "hyphen/*" {
  export function hyphenateSync(text: string, options?: { hyphenChar?: string; minWordLength?: number }): string;
}
