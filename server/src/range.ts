export interface ByteRange {
  start: number;
  end: number;
}

export function parseByteRange(header: string, size: number): ByteRange | null {
  if (!Number.isSafeInteger(size) || size <= 0) {
    return null;
  }

  const match = /^bytes=(\d*)-(\d*)$/i.exec(header.trim());

  if (!match) {
    return null;
  }

  const [, startText, endText] = match;

  if (startText === "" && endText === "") {
    return null;
  }

  if (startText === "") {
    const suffixLength = Number(endText);

    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) {
      return null;
    }

    return {
      start: Math.max(0, size - suffixLength),
      end: size - 1,
    };
  }

  const start = Number(startText);
  const requestedEnd = endText === "" ? size - 1 : Number(endText);

  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(requestedEnd) ||
    start >= size ||
    requestedEnd < start
  ) {
    return null;
  }

  return {
    start,
    end: Math.min(requestedEnd, size - 1),
  };
}
