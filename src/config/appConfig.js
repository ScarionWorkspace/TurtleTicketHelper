const {
    OPEN_TICKET_CATEGORY_ID,
    CLOSED_TICKET_CATEGORY_ID,
    TICKET_TOOL_BOT_ID,
    CLASHPERK_BOT_ID,
    ROSTER_WEBSITE_LEADERBOARD_URL
} = require('./env');

const appConfig = {
    // Roles that are allowed to use staff-only features
    staffRoleIds: [
        '1444000343431053332', // leader
        '1444000229576671303', // co-leader
        '1456074413412716780', // apprentice-leader
        '1456069556434108483', // recruiter
        '1503440082336743558'  // test (Scarion DC)
        // Add more staff role IDs here, separated by commas
    ],

    // Base ticket settings and Discord IDs
    ticket: {
        openCategoryId: OPEN_TICKET_CATEGORY_ID,
        closedCategoryId: CLOSED_TICKET_CATEGORY_ID,
        ticketToolBotId: TICKET_TOOL_BOT_ID,

        // Delay before a closed ticket channel gets deleted
        autoDeleteClosedChannelMs: 10000
    },

    clashPerk: {
        botId: CLASHPERK_BOT_ID,
        linkSavedMessage: 'Link Saved',
        ambiguousDisplayNameMessage:
            'Website sync did not work for {playerTag} because the Discord display name "{displayName}" is ambiguous. Please manually create the link or sync using the import function in the admin panel.',
        missingDisplayNameMessage:
            'Website sync did not work for {playerTag} because no Discord member with display name "{displayName}" was found. Please manually create the link or sync using the import function in the admin panel.',
        backendFailureMessage:
            'Website sync did not work for {playerTag} because the backend sync failed. Please manually create the link or sync using the import function in the admin panel.'
    },

    // Settings used when a new ticket channel is created
    ticketCreate: {
        // Small delay so Ticket Tool has time to send its first messages
        initialFetchDelayMs: 2500,

        // Fallback ticket type if no specific type can be detected
        defaultTicketType: 'ticket',

        // If detected, this ticket type will trigger the join clan prompt
        joinClanTicketType: 'join-clan',

        // Mapping of Ticket Tool topic texts to internal ticket type names
        topicMappings: {
            'new member': 'join-clan',
            'general support': 'general-support',
            'partnership': 'partnership',
            'claim reward': 'claim-reward'
        }
    },

    // Settings used when a ticket gets closed and auto-deleted
    ticketRename: {
        // Text that must appear in the Ticket Tool close message
        closeTriggerText: 'Ticket Closed by',

        // Prefix used by Ticket Tool for closed channels
        closedNamePrefix: 'closed-',

        // Warning message sent before auto-delete
        deleteWarningMessage: 'Ticket closed. This channel will be deleted in 10 seconds.',

        // Audit-log reason for deleting a closed ticket
        deleteReason: 'Auto-delete closed ticket channel'
    },

    // All texts, colors and labels for the join clan flow
    joinClan: {
        colors: {
            applicationEmbed: 0xF59E0B,
            recommendationEmbed: 0x57F287,
            promptEmbed: 0x57F287
        },

        prompt: {
            title: 'Introduce Yourself',
            description:
                'Click the button below to answer the questions about your main account and region.\n' +
                'Your Player Tag can be found by clicking the Profile Icon ingame.',
            startButtonLabel: 'Start Introduction'
        },

        recommendationMenu: {
            buttonLabel: 'Recommend Clan',
            placeholder: 'Choose a clan recommendation',
            openMessage: 'Select which clan you want to recommend:',
            notYourMenuMessage: 'This menu is not for you.',
            staffOnlyMessage: 'This menu is staff only.',
            invalidSelectionMessage: 'Invalid clan selection.',
            sentMessagePrefix: 'Recommendation sent:'
        },

        modal: {
            title: 'Main Account',
            playerTagLabel: 'What is your Player Tag (main acc)?',
            playerTagPlaceholder: '#ABC123',
            accountCountLabel: 'How many accounts do you have?',
            accountCountPlaceholder: 'Choose your account count',
            continentLabel: 'Which continent are you from?',
            continentPlaceholder: 'Choose your continent'
        },

        application: {
            title: 'Join Clan Application',
            descriptionPrefix: 'Submitted by',
            applicantFooterPrefix: 'Applicant ID:',
            submittedButtonLabel: 'Application Submitted',
            successMessage: 'Your application was submitted successfully.',
            playerNotFoundMessage: 'Player tag not found. Please check the tag and try again.',
            invalidPlayerTagMessage: 'Invalid player tag. Please check the tag and try again.',
            genericErrorMessage: 'Something went wrong while submitting your application.',
            staffOnlyButtonMessage: 'This button is staff only.',

            // Labels used in the application embed
            fields: {
                applicant: 'Applicant',
                playerName: 'Player Name',
                playerTag: 'Player Tag',
                townHall: 'Town Hall',
                league: 'League',
                warStars: 'War Stars',
                accounts: 'Accounts',
                continent: 'Continent',
                currentClan: 'Current Clan'
            }
        },

        // Text building blocks for the recommendation embed
        recommendationEmbed: {
            titlePrefix: 'Clan Recommendation:',
            introPrefix: 'We think',
            introSuffix: 'is the best fit for you.',
            linkLabel: 'Clan Link:',
            recommendedByPrefix: 'Recommended by'
        },

        accountCountOptions: {
            '1': {
                label: '1',
                description: 'One account',
                roleId: '1445712029393617089'
            },
            '2': {
                label: '2',
                description: 'Two accounts',
                roleId: '1445712054877950013'
            },
            '3plus': {
                label: '3+',
                description: 'Three or more accounts',
                roleId: '1445712087123890176'
            }
        },

        continentOptions: {
            europe: {
                label: 'Europe',
                description: 'Europe',
                roleId: '1445711595866161304'
            },
            north_america: {
                label: 'North America',
                description: 'North America',
                roleId: '1445711630997655736'
            },
            south_america: {
                label: 'South America',
                description: 'South America',
                roleId: '1445711668213710920'
            },
            asia: {
                label: 'Asia',
                description: 'Asia',
                roleId: '1445711704146313236'
            },
            oceania: {
                label: 'Oceania',
                description: 'Oceania',
                roleId: '1445711757879541852'
            },
            africa: {
                label: 'Africa',
                description: 'Africa',
                roleId: '1445711726816268299'
            }
        },

        townHallRoles: {
            12: '1445711841916354650',
            13: '1445711872551550976',
            14: '1445711890037735504',
            15: '1445711915572662292',
            16: '1445711936711819336',
            17: '1445711967309402145',
            18: '1445711989329625171'
        },

        roleUpdateReason: 'Join clan application role update'
    },

    seasonEvents: {
        maxLeaderboardRows: 10,
        websiteLeaderboardUrl: ROSTER_WEBSITE_LEADERBOARD_URL,
        // Optional override. When empty or omitted, staffRoleIds are used.
        adminRoleIds: [],
        colors: {
            push: 0x2ECC71,
            donation: 0x3498DB,
            neutral: 0x95A5A6,
            warning: 0xF59E0B,
            error: 0xED4245
        },
        labels: {
            pushTitle: 'Push Event',
            donationTitle: 'Donation Event',
            refresh: 'Refresh',
            signup: 'Signup',
            optOut: 'Opt-out',
            options: 'Options'
        },
        infoMessages: {
            push:
                'Sign up to participate in the current push event. ' +
                'The highest pusher at the end of the season wins. ' +
                'You must be in one of our clans at the end of the event to be able to win.',
            donation:
                'Sign up to participate in the current donation event. ' +
                'The highest donor at the end of the event wins. ' +
                'Leaving a clan before the event ends does not disqualify your donation result.'
        }
    },

    // Clan options shown in the recommendation menu
    clanRecommendations: {
        hyper_gizards: {
            name: 'Hyper Gizards',
            description: 'Recommend Hyper Gizards',
            link: 'https://link.clashofclans.com/en?action=OpenClanProfile&tag=2Q0YGUP08'
        },
        turtle: {
            name: 'TURTLE',
            description: 'Recommend TURTLE',
            link: 'https://link.clashofclans.com/en/?action=OpenClanProfile&tag=8L28LJCC'
        },
        purple_turtle: {
            name: 'Purple Turtle',
            description: 'Recommend Purple Turtle',
            link: 'https://link.clashofclans.com/en/?action=OpenClanProfile&tag=2JJ9UG82C'
        },
        turtle_cwl: {
            name: 'Turtle CWL',
            description: 'Recommend Turtle CWL',
            link: 'https://link.clashofclans.com/en?action=OpenClanProfile&tag=2JPY2LPQ2'
        }
    }
};

module.exports = appConfig;
