---
name: moodle-setup
description: Connect the Moodle MCP server to the user's Moodle account so agents can read their courses, materials, deadlines and grades. Use when the user wants to set up or connect Moodle, when Moodle tools report "not set up", or when a token stops working.
---

# Moodle setup

Connect this Moodle MCP server to the user's Moodle account (macOS, Windows or Linux).

**Never ask for, accept or print the user's password or token.** The user types them only into `setup.js`, in their own terminal.

## 1. Locate the code

- **Installed as a Claude Code plugin:** the repo root is two folders above this file, and the `moodle` MCP server is already registered. Skip step 5.
- **Otherwise:** clone it with `git clone https://github.com/IsaacAnwar/moodle-mcp "$HOME/moodle-mcp"`. On Windows, PowerShell accepts `$HOME` too.

Below, `<repo>` means the absolute path to that folder.

## 2. Check Node.js

Run `node --version`. It must be 18 or newer. If Node is missing:
- **macOS:** `brew install node`
- **Windows:** `winget install OpenJS.NodeJS.LTS`
- **Either:** the installer from https://nodejs.org

After installing, the user must open a new terminal.

## 3. Check the school's site

Ask the user for their Moodle link. Any page works, e.g. their dashboard. Then run:

```
node "<repo>/setup.js" --probe <url>
```

- **Exit code 0:** supported. The output says whether login is by password or by single sign-on.
- **Exit code 2:** the school has turned off the Moodle mobile API. Stop and explain that this tool can't work for that site.
- **Exit code 1:** the URL is wrong or the site isn't Moodle. Ask the user for the correct link.

## 4. The user creates the token

Tell the user to open a **new terminal window** (Terminal on macOS, PowerShell on Windows) and run:

```
node "<repo>/setup.js" <url>
```

The script asks for their Moodle username and a hidden password. Schools that use single sign-on get step-by-step instructions instead. It saves the token to `~/.moodle-mcp/config.json`, readable only by the user. Wait until they say it printed "Connected as ...".

Don't run this command yourself. It needs an interactive terminal and the user's credentials, and the `!` prefix doesn't work for it.

## 5. Register the server

Skip this step if the plugin is installed.

```
claude mcp add --scope user moodle node "<repo>/server.js"
```

For other MCP clients (Claude Desktop, Cursor, etc.), add a stdio server with command `node` and args `["<repo>/server.js"]`.

## 6. Verify

Run `node "<repo>/server.js" --check`. It should print `OK: connected to ... as <name>`. Then tell the user to restart Claude Code. The tools load in new sessions: `list_courses`, `get_deadlines`, `get_course_contents`, `download_course_files`, `get_grades` and more.

## Troubleshooting

- **`invalidlogin`:** try the other username format (full email or the short username), then rerun step 4.
- **The token stopped working,** e.g. after a password change: rerun step 4.
- **Downloads go to the wrong place:** they default to `Desktop/Moodle Files`. Add `"download_dir": "<path>"` to `~/.moodle-mcp/config.json` to change it.
- **To disconnect:** delete `~/.moodle-mcp/config.json`.
