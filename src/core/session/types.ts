export interface SessionReader {
  /** Extracts plain conversation text. Returns "" rather than throwing when the
   *  content is not a session we recognise. */
  read(transcriptPath: string): Promise<string>;
  /** True when the title is a host-generated placeholder, i.e. ours to replace. */
  isDefaultTitle(title: string): boolean;
}
