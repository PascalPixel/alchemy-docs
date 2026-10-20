// What Doxygen reads of the games' C: scripts/content.ts copies every file
// through it into .doxygen/src, in one process, rather than run it as
// Doxygen's INPUT_FILTER once per file. The source writes its
// documentation in Doxygen's line form already (///, /// @file, ///<), so
// Doxygen reads it as it is; the filter only keeps a paragraph laid out by
// hand, such as a frame timeline, as it is written, which Doxygen would
// otherwise flow into one line. Every line keeps its number, and the source
// files are not changed.

const isDoc = (line: string) => /^\/\/\/(?!<)/.test(line);

// The commands go on the paragraph's own lines. A paragraph is laid out when
// one of its lines is indented past "/// "; a list whose items continue on
// indented lines is not.
function preformat(lines: string[], start: number, end: number) {
  for (let i = start; i < end; ) {
    let stop = i;
    while (stop < end && lines[stop] !== '///') stop++;
    const paragraph = lines.slice(i, stop);
    const laidOut =
      paragraph.length > 0 &&
      paragraph.some((l) => /^\/\/\/ {3,}\S/.test(l)) &&
      !paragraph[0].startsWith('/// - ') &&
      !paragraph[0].startsWith('/// @');
    if (laidOut) {
      lines[i] = '/// @verbatim' + lines[i].slice(3);
      lines[stop - 1] += ' @endverbatim';
    }
    i = stop + 1;
  }
}

export function filter(source: string): string {
  const lines = source.split('\n');
  for (let i = 0; i < lines.length; ) {
    if (!isDoc(lines[i])) {
      i++;
      continue;
    }
    let end = i;
    while (end < lines.length && isDoc(lines[end])) end++;
    // A file's block: its "/// @file" line is a paragraph of its own here.
    preformat(lines, lines[i] === '/// @file' ? i + 1 : i, end);
    i = end;
  }
  return lines.join('\n');
}
