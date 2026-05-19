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
                roleId: '1504242925763039242'
            },
            '2': {
                label: '2',
                description: 'Two accounts',
                roleId: '1504242954091368458'
            },
            '3plus': {
                label: '3+',
                description: 'Three or more accounts',
                roleId: '1504242978687029388'
            }
        },

        continentOptions: {
            europe: {
                label: 'Europe',
                description: 'Europe',
                roleId: '1504243015521402880'
            },
            north_america: {
                label: 'North America',
                description: 'North America',
                roleId: '1504243063285874849'
            },
            south_america: {
                label: 'South America',
                description: 'South America',
                roleId: '1504243117799247962'
            },
            asia: {
                label: 'Asia',
                description: 'Asia',
                roleId: '1504243042474004632'
            },
            oceania: {
                label: 'Oceania',
                description: 'Oceania',
                roleId: '1504243092042289244'
            },
            africa: {
                label: 'Africa',
                description: 'Africa',
                roleId: '1504243160795185182'
            }
        },

        townHallRoles: {
            12: '1504242621843767346',
            13: '1504242714676297898',
            14: '1504242776286429224',
            15: '1504242802865995807',
            16: '1504242825620099072',
            17: '1504242846016995348',
            18: '1504242895048413378'
        },

        roleUpdateReason: 'Join clan application role update'
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