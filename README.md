# moodle-mcp

Give Claude (or any MCP-compatible AI agent) read-only access to your Moodle: courses, slides and readings, deadlines, assignments, grades, feedback and announcements. It works on macOS, Windows and Linux, needs no dependencies, and only requires Node.js 18 or newer.

## Install

**Claude Code (recommended):**
```
/plugin marketplace add IsaacAnwar/moodle-mcp
/plugin install moodle@moodle-mcp
```
Then tell Claude to "set up Moodle". The bundled `moodle-setup` skill walks you through the rest.

**Any other agent:** tell it to "set up https://github.com/IsaacAnwar/moodle-mcp by following `skills/moodle-setup/SKILL.md`".

**Manual setup:**
```
git clone https://github.com/IsaacAnwar/moodle-mcp && cd moodle-mcp
node setup.js https://your-moodle-site.edu         # enter your login here, in your own terminal
claude mcp add --scope user moodle node "$PWD/server.js"
node server.js --check
```

Your school must have the Moodle mobile app API enabled. Most do. Run `node setup.js --probe <url>` to check yours. Schools that use single sign-on are supported: setup walks you through copying a login link from your browser.

## Tools

| Tool | What it does |
|---|---|
| `list_courses` | Lists your current courses, or past ones too |
| `get_course_contents` | Shows a course's sections, activities, files and links |
| `search_materials` | Searches activity names, descriptions and filenames across courses |
| `get_file` | Returns a page as text, or saves a file (PDF, PPTX, XLSX…) locally |
| `download_course_files` | Downloads a whole course to your Desktop, fetching only new or changed files |
| `get_deadlines` | Lists upcoming to-dos and calendar events |
| `get_assignments` / `get_assignment_details` | Shows instructions, attachments, your submission status, grades and feedback |
| `get_grades` | Shows course totals, or an item-by-item breakdown |
| `get_forum_discussions` / `get_discussion` | Shows announcements and forum threads |
| `get_notifications` | Shows recent Moodle notifications |

## Configuration

`setup.js` writes `~/.moodle-mcp/config.json`, which only you can read:

```json
{ "url": "https://moodle.school.edu", "token": "…", "timezone": "Europe/Madrid", "download_dir": "/path/to/folder" }
```

`timezone` and `download_dir` are optional. By default the server uses your system time zone and saves files to `Desktop/Moodle Files`, using OneDrive-redirected Desktops on Windows. The environment variables `MOODLE_URL`, `MOODLE_TOKEN`, `MOODLE_TZ` and `MOODLE_DOWNLOAD_DIR` override the file.

## Security

- **Read-only:** the server calls only Moodle's read functions. It can't submit, post or change anything.
- **Same access as you:** the token sees only what you can already see in your browser.
- **Your token stays on your Moodle site:** it's only ever sent to that site, over HTTPS and inside the request body, never in a URL. File links pointing to other hosts are refused. Tool output never includes the token.
- **Your password isn't stored:** it's used once to create the token and then discarded.
- **Disconnecting:** to disconnect, delete `~/.moodle-mcp/config.json`. Changing your Moodle password usually revokes the token too.

## License

MIT
