const {
    assertBotConfig,
    getConfigReport,
    getConfigWarnings
} = require('../src/config/env');

function printReport() {
    console.log('Configuration report:');

    for (const item of getConfigReport()) {
        const source = item.source || 'not set';
        const value = item.configured ? item.value : '<missing>';

        console.log(`- ${item.name}: ${value} (${source})`);
    }
}

function main() {
    printReport();

    for (const warning of getConfigWarnings()) {
        console.warn(`Warning: ${warning}`);
    }

    assertBotConfig();

    console.log('Bot startup configuration looks valid.');
}

try {
    main();
} catch (error) {
    console.error(error.message || error);
    process.exitCode = 1;
}
