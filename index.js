"use strict";

// const rp = require("request-promise-native");
const axios = require("axios");
const delay = require("delay");
const cheerio = require("cheerio");
const https = require('https');
const SocksAgent = require('axios-socks5-agent');
const fs = require("fs");

const proxies = {
    good: {},
    bad: {},
    // "socks5://192.168.0.13:9050": {
    //     key: "0",
    //     ip: '192.168.0.13',
    //     port: '9050',
    //     protocols: ['socks5']
    // }
};
if (fs.existsSync("data/known_proxies.json")) {
    Object.assign(proxies, JSON.parse(fs.readFileSync("data/known_proxies.json", {encoding: "utf-8"})));
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
        function ($, listItem$, proxies, index) {

            const ip$ = listItem$.find('td:nth-child(1)');
            const port$ = listItem$.find('td:nth-child(2)');
            const https$ = listItem$.find('td:nth-child(7)');

            const ip = ip$.text().trim();
            const port = port$.text().trim();
            const https = https$.text().trim();

            if (https === 'yes') {
                let proxy = {
                    ip,
                    port,
                    protocols: ['https'],
                    lastCheck: Date.now()
                };
                proxy.key = `${proxy.protocols[0]}://${proxy.ip}:${proxy.port}`;
                if (proxies.bad[proxy.key] && (proxies.bad[proxy.key].lastCheck || 0) < (Date.now() - 15000)) {
                    delete proxies.bad[proxy.key]
                }
                if (!proxies.bad[proxy.key]) {
                    proxies.good[proxy.key] = proxy;
                }
            }

        }, reason => {
            console.error(reason);
        }, true)

}

let saving = false;
function saveProxies() {
    if (saving) {
        return setTimeout(saveProxies, 67);
    }
    saving = true;
    fs.writeFileSync("data/known_proxies.json", JSON.stringify(proxies, null, 2), {encoding: "utf-8"});
    saving = false;
}

const gettingProxy = {};
async function getNextProxy() {
    if (Object.keys(proxies.good).length < 4) {
        await getProxies();
    }
    let proxyAsSt;
    let error;
    let httpAgent, httpsAgent;
    let currentProxy;
    do {
        if (Object.keys(proxies.good).length < 4) {
            await getProxies();
        }
        currentProxy = getRandomProxyKey();
        while (gettingProxy[currentProxy]) {
            await delay(67);
        }
        gettingProxy[currentProxy] = true;
        if (!proxies.good[currentProxy]) {
            error = true;
            continue;
        }
        proxyAsSt = `${proxies.good[currentProxy].protocols[0]}://${proxies.good[currentProxy].ip}:${proxies.good[currentProxy].port}`;

        if (!proxies.good[currentProxy].checked) {
            console.log('Testing proxy', currentProxy, ", total =", Object.keys(proxies.good).length);

            const response = await axios.get('https://api.ipify.org?format=json', {
                proxy: {
                    host: proxies.good[currentProxy].ip,
                    port: proxies.good[currentProxy].port,
                },
                json: true,
                timeout: 30000,
            }).catch(reason => {
                console.log('PROXY ERROR: ', proxyAsSt, reason.name, reason.message);
                error = reason;
                return {error: reason}
            });
            if (!response.data || !response.data.ip) {
                error = true;
                proxies.bad[currentProxy] = proxies.good[currentProxy];
                delete proxies.good[currentProxy];
            } else {
                error = false;
                proxies.good[currentProxy].checked = true;
                console.log(`Proxy [${currentProxy}]${proxyAsSt} is OK`);
            }
            saveProxies();
        }
        delete gettingProxy[currentProxy];

    } while (error || !proxies.good[currentProxy]);
    proxies.good[currentProxy].key = proxies.good[currentProxy].key || currentProxy
    return {proxy: proxies.good[currentProxy], httpAgent, httpsAgent};
}

function getRandomProxyKey() {
    let randomIndex = Math.floor(Math.random() * Object.keys(proxies.good).length);
    return Object.keys(proxies.good)[randomIndex];
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
                host: proxy.ip,
                port: proxy.port,
            } : undefined,
            // httpsAgent: new https.Agent({
            //     rejectUnauthorized: false
            // }),
            // rejectUnauthorized:false,
            // strictSSL: false,
            // resolveWithFullResponse: true,
            // httpAgent, httpsAgent,
            timeout: 30000,
        }).catch(reason => {
            if (
                reason.message.indexOf(':SSL ') !== -1 ||
                reason.code === 'ETIMEDOUT' ||
                reason.code === 'ECONNREFUSED' ||
                reason.code === 'ECONNRESET' ||

                (reason.response || {}).status === 400 ||
                (reason.response || {}).status === 403
            ) {
                console.log('Discard proxy', proxy.key, 'for:', reason.message);
                proxies.bad[proxy.key] = proxy;
                delete proxies.good[proxy.key];
                saveProxies();
                reTry = true;
            } else if (
                reason.code === 'ERR_REQUEST_ABORTED' ||
                (reason.response || {}).status === 500 ||
                (reason.response || {}).status === 502 ||
                (reason.response || {}).status === 504
            ) {
                console.log('Failed with proxy', proxy.key, ', retry');
                reTry = true;
            } else {
                return errorHandler(reason);
            }
        });
        if (reTry) {
            await delay(1000);
        }
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