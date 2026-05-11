const appConfig = {
    // Roles that are allowed to use staff-only features
    staffRoleIds: [
        '1503440082336743558'
        // Add more staff role IDs here, separated by commas
    ],

    // Base ticket settings and Discord IDs
    ticket: {
        openCategoryId: process.env.OPEN_TICKET_CATEGORY_ID || '',
        closedCategoryId: process.env.CLOSED_TICKET_CATEGORY_ID || '',
        ticketToolBotId: process.env.TICKET_TOOL_BOT_ID || '',

        // Delay before a closed ticket channel gets deleted
        autoDeleteClosedChannelMs: 10000
    },

    // Settings used when a new ticket channel is created
    ticketCreate: {
        // Small delay so Ticket Tool has time to send its first messages
        initialFetchDelayMs: 2500,

        // Fallback ticket type if no specific type can be detected
        defaultTicketType: 'ticket',

        // If detected, this ticket type will trigger the join clan prompt
        joinClanTicketType: 'join-clan'
    },

    // Settings used when a ticket gets closed and renamed
    ticketRename: {
        // Text that must appear in the Ticket Tool close message
        closeTriggerText: 'Ticket Closed by',

        // Prefix for renamed closed channels
        closedNamePrefix: 'closed-',

        deleteWarningMessage: 'Ticket closed. This channel will be deleted in 10 seconds.',
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
            title: 'Join Clan Application',
            description:
                'Click the button below to answer 3 short questions.\n' +
                'Your answers will be collected and posted in a clean format for the supporters.',
            startButtonLabel: 'Start Application'
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
            title: 'Join Clan Questions',
            playerTagLabel: 'What is your Player Tag (main acc)?',
            playerTagPlaceholder: '#ABC123',
            accountCountLabel: 'How Many Accounts?',
            accountCountPlaceholder: 'e.g. 2',
            continentLabel: 'Which Continent are you from?',
            continentPlaceholder: 'Europe'
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
            reasonLabel: 'Why this clan fits:',
            linkLabel: 'Clan Link:',
            recommendedByPrefix: 'Recommended by'
        }
    },

    // Clan options shown in the recommendation menu
    clanRecommendations: {
        hyper_gizards: {
            name: 'Hyper Gizards',
            description: 'Recommend Hyper Gizards',
            link: '(LINK)',
            explanation: '(EXPLANATION)'
        },
        turtle: {
            name: 'TURTLE',
            description: 'Recommend TURTLE',
            link: '(LINK)',
            explanation: '(EXPLANATION)'
        },
        purple_turtle: {
            name: 'Purple Turtle',
            description: 'Recommend Purple Turtle',
            link: '(LINK)',
            explanation: '(EXPLANATION)'
        },
        turtle_cwl: {
            name: 'Turtle CWL',
            description: 'Recommend Turtle CWL',
            link: '(LINK)',
            explanation: '(EXPLANATION)'
        }
    }
};

module.exports = appConfig;