"use strict";

// const rp = require("request-promise-native");
const axios = require("axios");
const delay = require("delay");
const cheerio = require("cheerio");
const https = require('https');
const SocksAgent = require('axios-socks5-agent');
const fs = require("fs");

const proxies = {
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
        function ($, listItem$, outResults, index) {

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
                    protocols: ['https']
                };
                proxy.key = `${proxy.protocols[0]}://${proxy.ip}:${proxy.port}`;
                outResults[proxy.key] = proxy;
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

async function getNextProxy() {
    if (!Object.keys(proxies).length) {
        await getProxies();
    }
    let proxyAsSt;
    let error;
    let httpAgent, httpsAgent;
    let currentProxy;
    do {
        if (!Object.keys(proxies).length) {
            await getProxies();
        }
        currentProxy = getRandomProxyKey();
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
            console.log('Testing proxy', currentProxy, ", total =", Object.keys(proxies).length);

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
                timeout: 30000,
            }).catch(reason => {
                console.log('PROXY ERROR: ', proxyAsSt, reason.name, reason.message);
                error = reason;
                return {error: reason}
            });
            if (!response.data || !response.data.ip) {
                error = true;
                delete proxies[currentProxy];
            } else {
                error = false;
                proxies[currentProxy].checked = true;
                console.log(`Proxy [${currentProxy}]${proxyAsSt} is OK`);
            }
            saveProxies();
        }

    } while (error || !proxies[currentProxy]);
    proxies[currentProxy].key = proxies[currentProxy].key || currentProxy
    return {proxy: proxies[currentProxy], httpAgent, httpsAgent};
}

function getRandomProxyKey() {
    let randomIndex = Math.floor(Math.random() * Object.keys(proxies).length);
    return Object.keys(proxies)[randomIndex];
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
                delete proxies[proxy.key];
                saveProxies();
                reTry = true;
            } else if (
                reason.code === 'ERR_REQUEST_ABORTED' ||
                (reason.response || {}).status === 500
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