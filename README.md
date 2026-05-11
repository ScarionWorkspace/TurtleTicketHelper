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
DISCORD_BOT_TOKEN=your_discord_bot_token_here
OPEN_TICKET_CATEGORY_ID=your_open_ticket_category_id_here
CLOSED_TICKET_CATEGORY_ID=your_closed_ticket_category_id_here
TICKET_TOOL_BOT_ID=your_ticket_tool_bot_id_here
CLASH_OF_CLANS_API_KEY=your_clash_of_clans_api_key_here
```

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

- `DISCORD_BOT_TOKEN`

### 2. Enable intents

In the **Bot** section of the Discord Developer Portal, enable these privileged intents:

- **Server Members Intent**
- **Message Content Intent**

These intents are required so the bot can detect ticket users and ticket message content correctly. [file:1044]

### 3. Required bot permissions

Invite the bot with these permissions:

- View Channels
- Manage Channels
- Send Messages
- Read Message History

Recommended additional permissions:

- Embed Links
- Attach Files
- Use External Emojis

The important part is that the bot can read ticket channels, rename channels, and send messages inside them. [file:1044]

## Clash of Clans API Setup

Create a Clash of Clans API key and add it to:

- `CLASH_OF_CLANS_API_KEY`

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

## Setup Checklist

- Discord bot token added to `.env`
- Open ticket category ID added to `.env`
- Closed ticket category ID added to `.env`
- Ticket Tool bot ID added to `.env`
- Clash of Clans API key added to `.env`
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
