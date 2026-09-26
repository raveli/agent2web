/**
 * The server's version, and what changed in it, for agents to read.
 *
 * An agent remembers behaviour across sessions, and nothing tells it when the
 * server moves on: after locked multi-file sites started working, an agent kept
 * obeying the old warning and refused to split a page. So the MCP instructions
 * carry the version and the latest changes, and say which source to trust.
 *
 * Bump VERSION with package.json (a test holds them together) and add a line
 * to CHANGES whenever agent-visible behaviour changes.
 */
export const VERSION = '0.2.0';

export const CHANGES: { version: string; date: string; notes: string[] }[] = [
  {
    version: '0.2.0',
    date: '2026-09-26',
    notes: [
      'Password-protected sites can have separate CSS, JS and data files when served on their own hostname; the old advice to inline everything no longer applies there.',
      'site_edit_file changes part of a file; site_extract_file splits a page into files on the server; site_stage_file uploads a large file in chunks.',
      'Updates now fail loudly if a carried-over file is missing, instead of dropping it.',
    ],
  },
];

/** The paragraph the MCP server adds to its instructions. */
export function versionNote(): string {
  const latest = CHANGES[0]!;
  return (
    `Server version ${VERSION}. Changes on ${latest.date}: ${latest.notes.join(' ')} ` +
    'The tool descriptions describe this server as it is now. If you remember different behaviour ' +
    'from an earlier session, trust the descriptions over your memory.'
  );
}
