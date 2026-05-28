# TurtleTicketHelper

TurtleTicketHelper is a Discord bot that works together with Ticket Tool.  
It automatically renames ticket channels, handles join clan applications, and fetches Clash of Clans player data for staff review.

## Features

- Renames newly created tickets based on ticket type and user name
- Renames closed tickets and deletes them automatically after a delay
- Sends a join clan application prompt inside join clan tickets
- Opens a modal for player application data
- Fetches Clash of Clans player information through the Clash of Clans API
- Lets staff recommend clans directly inside the ticket

## Requirements

Before setting up the bot, make sure you have:

- A Discord bot application
- A Discord bot token
- Ticket Tool installed on your Discord server
- A Clash of Clans API key
- Two Discord categories:
  - One for open tickets
  - One for closed tickets

## Environment Variables

Create a `.env` file in the project root:

```env
DISCORD_TOKEN=your_discord_bot_token_here
DISCORD_CLIENT_ID=your_discord_application_client_id_here
DISCORD_GUILD_ID=your_discord_server_id_here
OPEN_TICKET_CATEGORY_ID=your_open_ticket_category_id_here
CLOSED_TICKET_CATEGORY_ID=your_closed_ticket_category_id_here
TICKET_TOOL_BOT_ID=your_ticket_tool_bot_id_here
COC_API_TOKEN=your_clash_of_clans_api_key_here
```

`DISCORD_BOT_TOKEN` and `CLASH_OF_CLANS_API_KEY` are still accepted as compatibility aliases, but `DISCORD_TOKEN` and `COC_API_TOKEN` are the preferred names.

## Discord Setup

### 1. Create ticket categories

Create these two categories in your Discord server:

- `Open Tickets`
- `Closed Tickets`

Copy both category IDs and add them to your `.env` file:

- `OPEN_TICKET_CATEGORY_ID`
- `CLOSED_TICKET_CATEGORY_ID`

To copy IDs, enable **Developer Mode** in Discord, then right-click the category and choose **Copy ID**.

### 2. Get the Ticket Tool bot ID

Copy the Ticket Tool bot ID and add it to:

- `TICKET_TOOL_BOT_ID`

This ensures TurtleTicketHelper only reacts to Ticket Tool ticket messages.

### 3. Configure Ticket Tool

Open the Ticket Tool dashboard and configure your ticket system.

#### Select categories

In the Ticket Tool dashboard:

1. Open your ticket settings
2. Select both categories:
   - Open ticket category
   - Closed ticket category

#### Create panels

Go back to **Panel Config** and create 2 panels:

- `Join Clan`
- `Other Reasons`

Attach both panels to your ticket setup.

## Discord Bot Setup

### 1. Bot token

Open the [Discord Developer Portal](https://discord.com/developers/applications), select your application, go to **Bot**, and copy your bot token.

Add it to:

- `DISCORD_TOKEN`

### 2. Enable intents

In the **Bot** section of the Discord Developer Portal, enable these privileged intents:

- **Server Members Intent**
- **Message Content Intent**

These intents are required so the bot can detect ticket users and ticket message content correctly.

### 3. Required bot permissions

Invite the bot with the `bot` and `applications.commands` OAuth scopes, and these permissions:

- View Channels
- Manage Channels
- Manage Roles
- Send Messages
- Read Message History

Recommended additional permissions:

- Embed Links
- Attach Files
- Use External Emojis

The important part is that the bot can read ticket channels, rename channels, and send messages inside them.
Manage Roles is required if you use the join clan application role assignment flow.

## Clash of Clans API Setup

Create a Clash of Clans API key and add it to:

- `COC_API_TOKEN`

This key is used to fetch player data for the join clan application flow.

## Installation

Clone the repository and install dependencies:

```bash
git clone <your-repository-url>
cd TurtleTicketHelper
npm install
```

## Run the Bot

Start the bot with:

```bash
npm start
```

If everything is configured correctly, the bot should log in and begin reacting to Ticket Tool ticket events.

Validate local configuration without logging into Discord:

```bash
npm run check:config
```

Deploy guild slash commands:

```bash
npm run deploy:commands
```

## Setup Checklist

- Discord bot token added to `.env` as `DISCORD_TOKEN`
- Discord client/application ID added to `.env` as `DISCORD_CLIENT_ID`
- Discord server ID added to `.env` as `DISCORD_GUILD_ID`
- Open ticket category ID added to `.env`
- Closed ticket category ID added to `.env`
- Ticket Tool bot ID added to `.env`
- Clash of Clans API key added to `.env` as `COC_API_TOKEN`
- Server Members Intent enabled
- Message Content Intent enabled
- Ticket Tool configured with both categories
- Two panels created:
  - `Join Clan`
  - `Other Reasons`
- Bot invited with the required permissions

## Configuration

After setting up the `.env` file, you can change additional bot settings in `src/config/appConfig.js`.

This includes:

- staff role IDs
- join clan texts and embed settings
- clan recommendation names, links, and explanations
- ticket rename and ticket create settings

## `.gitignore`

Make sure your `.env` file is ignored:

```gitignore
# Environment variables
.env
.env.local
.env.*.local
```
