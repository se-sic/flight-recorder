import * as fs from "fs";

/** Incrementally reads newly appended content from a growing file, tracking a byte offset across reads. */
export class Tailer {
  private fd: number | null = null;
  private offset = 0;

  constructor(private filePath: string) {}

  /** Sets the read offset to the file's current end, so only future appends are read. */
  startFromEnd() {
    const st = fs.statSync(this.filePath);
    this.offset = st.size;
  }

  /** Opens the file descriptor used for subsequent reads. */
  open() {
    this.fd = fs.openSync(this.filePath, "r");
  }

  /** Closes the open file descriptor, if any. */
  close() {
    if (this.fd !== null) {
      fs.closeSync(this.fd);
    }
    this.fd = null;
  }

  /** Reads and returns any content appended since the last read (empty string if none, or if not open). */
  readNew(): string {
    if (this.fd === null) {
      return "";
    }
    const st = fs.statSync(this.filePath);
    if (st.size < this.offset) {
      // rotated/truncated
      this.offset = 0;
    }
    const len = st.size - this.offset;
    if (len <= 0) {
      return "";
    }

    const buf = Buffer.alloc(len);
    fs.readSync(this.fd, buf, 0, len, this.offset);
    this.offset = st.size;
    return buf.toString("utf8");
  }
}
