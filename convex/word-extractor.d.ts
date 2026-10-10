// word-extractor ships without types; this is the small part we use.
declare module "word-extractor" {
  export default class WordExtractor {
    extract(source: Buffer | string): Promise<{ getBody(): string }>;
  }
}
