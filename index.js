"use strict";

// const rp = require("request-promise-native");
const axios = require("axios");
const delay = require("delay");
const cheerio = require("cheerio");
const https = require('https');
const SocksAgent = require('axios-socks5-agent');
const fs = require("fs");

let proxies = [
    // {
    //     ip: '192.168.0.13',
    //     port: '9050',
    //     protocols: ['socks5']
    // }
];
let currentProxy = 0;
if (fs.existsSync("data/known_proxies.json")) {
    proxies = JSON.parse(fs.readFileSync("data/known_proxies.json", {encoding: "utf-8"}));
    currentProxy = proxies.length - 1;
}

async function getProxies() {
    console.log('Requesting new proxies');
    // // const response = await axios.get("https://proxylist.geonode.com/api/proxy-list?limit=50&page=1&sort_by=lastChecked&sort_type=desc&filterLastChecked=50&protocols=socks5", {
    // const response = await axios.get("https://proxylist.geonode.com/api/proxy-list?limit=50&page=1&sort_by=lastChecked&sort_type=desc&filterLastChecked=50&protocols=https", {
    // // const response = await axios.get("https://proxylist.geonode.com/api/proxy-list?limit=50&page=1&sort_by=lastChecked&sort_type=desc&filterLastChecked=50&protocols=http%2Chttps", {
    //     resolveWithFullResponse: true,
    //     json: true,
    // }).catch(reason => {
    //     console.error(reason);
    //     return {error: reason};
    // });
    //
    // const {data, total, page, limit} = response.data;
    // for (let i = 0; i < data.length; i++) {
    //     const proxyData = data[i];
    //     // console.log(proxyData);
    //     proxies.push(proxyData);
    // }


    await requestAndProcessPage('https://free-proxy-list.net/', {}, proxies, $ => $('#list > div > div.table-responsive > div > table > tbody > tr'),
        function ($, listItem$, outResults, index) {

            const ip$ = listItem$.find('td:nth-child(1)');
            const port$ = listItem$.find('td:nth-child(2)');
            const https$ = listItem$.find('td:nth-child(7)');

            const ip = ip$.text().trim();
            const port = port$.text().trim();
            const https = https$.text().trim();

            if (https === 'yes') {
                outResults.push({
                    ip,
                    port,
                    protocols: ['https']
                });
            }

        }, reason => {
            console.error(reason);
        }, true)

    currentProxy = proxies.length - 1;

}

function saveProxies() {
    fs.writeFileSync("data/known_proxies.json", JSON.stringify(proxies), {encoding: "utf-8"});
}

async function getNextProxy() {
    if (!proxies.length) {
        await getProxies();
    }
    let proxyAsSt;
    let error;
    let httpAgent, httpsAgent;
    do {
        if (!proxies.length) {
            await getProxies();
        }
        proxyAsSt = `${proxies[currentProxy].protocols[0]}://${proxies[currentProxy].ip}:${proxies[currentProxy].port}`;

        ({httpAgent, httpsAgent} = SocksAgent({
            agentOptions: {
                keepAlive: true,
            },
            // socks5
            host: proxies[currentProxy].ip,
            port: proxies[currentProxy].port,
            // socks5 auth
            // username: 'admin',
            // password: 'pass1234',
        }));
        if (!proxies[currentProxy].checked) {
            console.log('Testing proxy', currentProxy);

            const response = await axios.get('https://api.ipify.org?format=json', {
                // proxy: proxyAsSt,
                proxy: {
                    host: proxies[currentProxy].ip,
                    port: proxies[currentProxy].port,
                },
                // resolveWithFullResponse: true,
                json: true,
                // httpsAgent: new https.Agent({
                //     rejectUnauthorized: false
                // }),
                // rejectUnauthorized:false,
                // strictSSL: false,
                // httpAgent, httpsAgent
            }).catch(reason => {
                console.log('PROXY ERROR: ', proxyAsSt, reason.name, reason.message);
                error = reason;
                return {error: reason}
            });
            if (!response.data || !response.data.ip) {
                error = true;
                proxies.splice(currentProxy, 1);
                currentProxy--;
            } else {
                error = false;
                proxies[currentProxy].checked = true;
            }
            saveProxies();
        }

    } while (error);
    return {proxy: proxyAsSt, httpAgent, httpsAgent};
}
async function requestAndProcessPage(url, options, outResults, listSelector, itemHandler, errorHandler, skipProxy = false) {
    let proxy, httpAgent, httpsAgent;
    let reTry = false;

    let response;
    do {
        reTry = false;
        if (!skipProxy) {
            ({proxy, httpAgent, httpsAgent} = await getNextProxy());
        }
        response = await axios.get(url, {
            ...options,
            // proxy,
            proxy: !skipProxy ? {
                host: proxies[currentProxy].ip,
                port: proxies[currentProxy].port,
            } : undefined,
            // httpsAgent: new https.Agent({
            //     rejectUnauthorized: false
            // }),
            // rejectUnauthorized:false,
            // strictSSL: false,
            // resolveWithFullResponse: true,
            // httpAgent, httpsAgent,
        }).catch(reason => {
            if (
                reason.message.indexOf(':SSL ') !== -1 ||
                reason.message.indexOf('ETIMEDOUT') !== -1 ||
                reason.message.indexOf('ECONNRESET') !== -1
            ) {
                // proxies.splice(currentProxy, 1);
                proxies.splice(0, proxies.length);
                // currentProxy = 0;
                // saveProxies();
                reTry = true;
            } else {
                return errorHandler(reason);
            }
        });
    } while (reTry)
    // await delay(5000 + Math.random() * 1000);

    let $;

    if (response.data) {
        $ = cheerio.load(response.data);
        processHtml($, outResults, listSelector || ($ => $.root()), itemHandler);
    }
    return {$, response};
}

function processHtml($, outResults, listSelector, itemHandler) {
    const allTopics = listSelector($);
    let index = 0;
    allTopics.each(function () {
        itemHandler.call(this, $, $(this), outResults, index);

        index++;
    });

    return outResults;
}

module.exports.requestAndProcessPage = requestAndProcessPage;