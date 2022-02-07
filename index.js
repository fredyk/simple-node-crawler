"use strict";

const axios = require("axios");
const delay = require("delay");
const cheerio = require("cheerio");
const fs = require("fs");
const debug = require('debug')('simple-node-crawler:main');

const proxies = {
    good: {},
    bad: {},
};
if (fs.existsSync("data/known_proxies.json")) {
    Object.assign(proxies, JSON.parse(fs.readFileSync("data/known_proxies.json", {encoding: "utf-8"})));
}

function addProxy(proxy) {
    // proxy = {
    //     ...proxy,
    //     lastCheck: Date.now(),
    //     // enqueuedTimes: 1
    // }
    proxy.key = `${proxy.protocols[0]}://${proxy.ip}:${proxy.port}`;
    const proxyKey = proxy.key;
    // if (proxies.bad[proxyKey]) {
    //     return;
    // }
    // if (proxies.bad[proxyKey]) {
    //     if ((proxies.bad[proxyKey].lastCheck || 0) < (Date.now() - 15000)) {
    //         moveToGoodProxy(proxyKey);
    //         Object.assign(proxies.good[proxyKey], proxy);
    //         proxies.good[proxyKey].enqueuedTimes = (proxies.good[proxyKey].enqueuedTimes || 0) + 1;
    //     } else {
    //         // Still bad proxy
    //     }
    // } else {
    //     proxies.good[proxyKey] = proxies.good[proxyKey] || {};
    //     Object.assign(proxies.good[proxyKey], proxy);
    // }
    moveToGoodProxy(proxyKey);
    proxies.good[proxyKey] = proxies.good[proxyKey] || {};
    if (proxies.good[proxyKey]) {
        Object.assign(proxies.good[proxyKey], proxy);
        updateProxy(proxyKey, {$inc: {enqueuedTimes: 1}, $set: {lastCheck: Date.now()}})
    }
}

function updateProxy(key, atomicUpdate) {
    for (const [operator, payload] of Object.entries(atomicUpdate)) {
        switch (operator) {
            case '$inc':
                for (const [subKey, value] of Object.entries(payload)) {
                    if (proxies.good[key]) {
                        proxies.good[key][subKey] = proxies.good[key][subKey] || 0;
                        proxies.good[key][subKey] += value;
                    } else if (proxies.bad[key]) {
                        proxies.bad[key][subKey] = proxies.bad[key][subKey] || 0;
                        proxies.bad[key][subKey] += value;
                    }
                }
                break;
            case '$set':
                if (proxies.good[key]) {
                    Object.assign(proxies.good[key], payload);
                } else if (proxies.bad[key]) {
                    Object.assign(proxies.bad[key], payload);
                }
                break;
        }
    }
}

function moveToBadProxy(key) {
    if (proxies.good[key]) {
        proxies.bad[key] = proxies.bad[key] || {};
        Object.assign(proxies.bad[key], proxies.good[key]);
        delete proxies.good[key];
    }
}

function moveToGoodProxy(proxyKey) {
    if (proxies.bad[proxyKey]) {
        proxies.good[proxyKey] = proxies.good[proxyKey] || {};
        Object.assign(proxies.good[proxyKey], proxies.bad[proxyKey]);
        delete proxies.bad[proxyKey]
    }
}

async function getProxies() {
    debug('Requesting new proxies');


    let page = 1;
    let data, total, limit;
    do {
        // // const response = await axios.get("https://proxylist.geonode.com/api/proxy-list?limit=50&page=1&sort_by=lastChecked&sort_type=desc&filterLastChecked=50&protocols=socks5", {
        const response = await axios.get(`https://proxylist.geonode.com/api/proxy-list?limit=50&page=${page}&sort_by=lastChecked&sort_type=desc&filterLastChecked=50&protocols=https`, {
            // // const response = await axios.get("https://proxylist.geonode.com/api/proxy-list?limit=50&page=1&sort_by=lastChecked&sort_type=desc&filterLastChecked=50&protocols=http%2Chttps", {
            json: true,
        }).catch(reason => {
            console.log('ERROR while getting PROXY page', page, ':', reason.code, reason.message);
            return {error: reason};
        });

        data = [];
        if (response && response.data) {

            ({data, total/*, page*/, limit} = response.data);
            for (let i = 0; i < data.length; i++) {
                const proxyData = data[i];
                addProxy(proxyData);
            }
        }
        page++;
    } while (data.length >= 50)

    await requestAndProcessPage('https://free-proxy-list.net/', {}, proxies, $ => $('#list > div > div.table-responsive > div > table > tbody > tr'),
        function ($, listItem$, _, index) {

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
                };
                addProxy(proxy);
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
    try {
        fs.writeFileSync("data/known_proxies.json", JSON.stringify(proxies, null, 2), {encoding: "utf-8"});
    } catch (e) {
        console.error(e);
    }
    saving = false;
}

async function getNextProxy() {
    if (Object.keys(proxies.good).length < 4) {
        await getProxies();
    }
    let proxy;
    do {
        let currentProxy = getRandomProxyKey();
        proxy = proxies.good[currentProxy];
        if (proxy) {
            return {proxy: proxy};
        }
    } while (!proxy)
}

function getRandomProxyKey() {
    let randomIndex = Math.floor(Math.random() * Object.keys(proxies.good).length);
    return Object.keys(proxies.good)[randomIndex];
}

async function requestAndProcessPage(url, options, outResults, listSelector, itemHandler, errorHandler, skipProxy = false) {
    const init = Date.now();
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
            proxy: !skipProxy ? {
                host: proxy.ip,
                port: proxy.port,
            } : undefined,
            timeout: 30000,
        }).catch(reason => {
            if (
                proxy && (
                    reason.message.indexOf(':SSL ') !== -1 ||
                    reason.code === 'ETIMEDOUT' ||
                    reason.code === 'ECONNREFUSED' ||
                    reason.code === 'ECONNRESET' ||
                    reason.code === 'ECONNABORTED' ||
                    reason.code === 'EADDRNOTAVAIL' ||
                    reason.code === 'ENETUNREACH' ||
                    reason.code === 'HPE_INVALID_CONSTANT' ||
                    reason.code === 'HPE_INVALID_HEADER_TOKEN' ||

                    (reason.response || {}).status === 501 ||
                    (reason.response || {}).status === 400 ||
                    (reason.response || {}).status === 403 ||
                    (reason.response || {}).status === 404 ||

                    reason.message.indexOf('timeout of ') !== -1 ||
                    reason.message.indexOf('error request aborted ') !== -1 ||
                    reason.code === 'ERR_REQUEST_ABORTED' ||
                    (reason.response || {}).status === 500 ||
                    (reason.response || {}).status === 502 ||
                    (reason.response || {}).status === 503 ||
                    (reason.response || {}).status === 504)
            ) {
                debug('Discard proxy', proxy.key, 'for:', reason.message);

                updateProxy(proxy.key, {$inc: {badHits: 1}});
                // moveToBadProxy(proxy.key);
                //
                // saveProxies();
                reTry = true;
            } else if (
                !proxy
                //     reason.message.indexOf('timeout of ') !== -1 ||
                //     reason.message.indexOf('error request aborted ') !== -1 ||
                //     reason.code === 'ERR_REQUEST_ABORTED' ||
                //     (reason.response || {}).status === 500 ||
                //     (reason.response || {}).status === 502 ||
                //     (reason.response || {}).status === 503 ||
                //     (reason.response || {}).status === 504
            ) {
                //     debug('Failed with proxy', proxy.key, reason.message, ', retry');
                reTry = true;
            } else {
                return errorHandler(reason);
            }
        });
        if (response && (response.data || '').startsWith('<pre>Array')) {
            reTry = true;
        }
        if (reTry) {
            await delay(1000);
        }
    } while (reTry)

    let $;

    if (response.data) {
        $ = cheerio.load(response.data);
        processHtml($, outResults, listSelector || ($ => $.root()), itemHandler);
        if (proxy) {
            updateProxy(proxy.key, {$inc: {goodHits: 1, scUpTime: ((Date.now() - init) / 1000)}});
            saveProxies();
        }
    }
    return {$, response};
}

function processHtml($, outResults, listSelector, itemHandler) {
    const items = listSelector($);
    for (let i = 0; i < items.length; i++) {
        const item = items[i];
        itemHandler($, $(item), outResults, i, items);
    }

    return outResults;
}

setInterval((() => {
    let maxGoodHits = 0;
    let minHitDelta = 0;
    let maxHitDelta = 0;
    let threshold = 0;
    return () => {
        let found = false;
        let localMaxGoodHits = 0;
        let localMinHitDelta = 1e6;
        let localMaxHitDelta = -1e6;
        let localAvgScore = 0;
        let countForAvgScore = 0;

        for (const type of ['good', 'bad']) {
            for (const [key, proxy] of Object.entries(proxies[type])) {
                let score = 0;
                if (typeof proxy.goodHits !== "undefined" && typeof proxy.badHits !== "undefined") {
                    localMaxGoodHits = Math.max(localMaxGoodHits, proxy.goodHits);
                    let hitDelta = 0;
                    hitDelta = proxy.goodHits - proxy.badHits;
                    localMinHitDelta = Math.min(localMinHitDelta, hitDelta);
                    localMaxHitDelta = Math.max(localMaxHitDelta, hitDelta);
                    if (maxGoodHits && minHitDelta && maxHitDelta) {
                        let biasedDelta = hitDelta;
                        let biasedMaxDelta = maxHitDelta;
                        if (minHitDelta < 0) {
                            biasedDelta = hitDelta + Math.abs(minHitDelta);
                            biasedMaxDelta = maxHitDelta + Math.abs(minHitDelta);
                        }
                        score = proxy.goodHits / maxGoodHits * 0.5 + biasedDelta / biasedMaxDelta * 0.5;
                        updateProxy(key, {$set: {score: score}});
                        countForAvgScore++;
                        localAvgScore = (localAvgScore * (countForAvgScore - 1) + score) / countForAvgScore;
                    }
                }

            }
        }
        maxGoodHits = localMaxGoodHits;
        minHitDelta = localMinHitDelta;
        maxHitDelta = localMaxHitDelta;
        if (localAvgScore) {
            threshold = localAvgScore * 0.5 + 0.5;
        }

        for (const [key, proxy] of Object.entries(proxies.good)) {

            let score = 0;
            if (proxy.goodHits) {
                let hitDelta = 0;
                if (typeof proxy.badHits !== "undefined") {
                    hitDelta = proxy.goodHits - proxy.badHits;
                }
                if (maxGoodHits && minHitDelta && maxHitDelta) {
                    let biasedDelta = hitDelta;
                    let biasedMaxDelta = maxHitDelta;
                    if (minHitDelta < 0) {
                        biasedDelta = hitDelta + Math.abs(minHitDelta);
                        biasedMaxDelta = maxHitDelta + Math.abs(minHitDelta);
                    }
                    score = proxy.goodHits / maxGoodHits * 0.5 + biasedDelta / biasedMaxDelta * 0.5;
                    updateProxy(key, {$set: {score: score}});
                }
            }

            if (threshold && score < threshold && Math.random() >= 0.0) {
                moveToBadProxy(key);
                found = true;
            }
        }
        for (const [key, proxy] of Object.entries(proxies.bad)) {

            let score = 0;

            let hitDelta = 0;
            if (typeof proxy.goodHits !== "undefined" && typeof proxy.badHits !== "undefined") {
                hitDelta = proxy.goodHits - proxy.badHits;
                if (maxGoodHits && minHitDelta && maxHitDelta) {
                    let biasedDelta = hitDelta;
                    let biasedMaxDelta = maxHitDelta;
                    if (minHitDelta < 0) {
                        biasedDelta = hitDelta + Math.abs(minHitDelta);
                        biasedMaxDelta = maxHitDelta + Math.abs(minHitDelta);
                    }
                    score = proxy.goodHits / maxGoodHits * 0.5 + biasedDelta / biasedMaxDelta * 0.5;
                    updateProxy(key, {$set: {score: score}});
                }
            }

            if (threshold && score >= threshold || typeof proxy.goodHits !== "undefined" && Math.random() < 0.001) {
                moveToGoodProxy(key);
                found = true;
            }
        }

        if (Math.random() >= 0.999) {
            const randomIp = `${1 + Math.round(Math.random() * 254)}.${1 + Math.round(Math.random() * 254)}.${1 + Math.round(Math.random() * 254)}.${1 + Math.round(Math.random() * 254)}`;
            const ports = ['80', '443', '1080', '8080'];
            const proxy = {
                ip: randomIp,
                port: ports[Math.round(Math.random() * (ports.length - 1))],
                protocols: ['https'],
                isRandom: true,
            }
            addProxy(proxy);
        }
        if (found) {
            saveProxies();
        }
    };
})(), 5000);
module.exports.requestAndProcessPage = requestAndProcessPage;