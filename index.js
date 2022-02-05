"use strict";

const rp = require("request-promise-native");
const delay = require("delay");
const cheerio = require("cheerio");

async function requestAndProcessPage(url, options, outResults, listSelector, itemHandler, errorHandler) {
    const response = await rp.get(url, {
        ...options,
        resolveWithFullResponse: true,
    }).promise().catch(errorHandler);
    await delay(5000);

    const $ = cheerio.load(response.body);

    processHtml($, outResults, listSelector, itemHandler);
    return {$, response};
}

function processHtml($, outResults, listSelector, itemHandler) {
    const allTopics = listSelector($);
    let index = 0;
    allTopics.each(function () {
        itemHandler($, outResults, index);

        index++;
    });

    return outResults;
}

module.exports.requestAndProcessPage = requestAndProcessPage;