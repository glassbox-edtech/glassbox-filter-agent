// ==========================================
// 🤝 THE STARTUP HANDSHAKE
// ==========================================
async function performHandshake(studentHash) {
    try {
        const configUrl = chrome.runtime.getURL("config.json");
        const config = await (await fetch(configUrl)).json();
        const baseUrl = config.workerUrl.endsWith('/') ? config.workerUrl.slice(0, -1) : config.workerUrl;

        const res = await fetch(`${baseUrl}/api/student/me?hash=${studentHash}`);
        
        if (res.status === 404) {
            console.log("⚠️ Student not registered. Opening setup page...");
            chrome.tabs.create({ url: chrome.runtime.getURL("setup.html") });
            return false;
        } else if (res.ok) {
            const data = await res.json();
            await chrome.storage.local.set({ schoolId: data.schoolId });
            console.log(`✅ Student securely locked to school ID: ${data.schoolId}`);
            return true;
        }
    } catch (err) {
        console.error("Handshake failed (offline?).", err);
        return false;
    }
}

// ==========================================
// 🚀 INITIALIZATION & SETUP
// ==========================================
chrome.runtime.onInstalled.addListener(async () => {
    console.log("Glassbox Installed. Initializing Engine...");

    chrome.alarms.create("syncGlassboxRules", { periodInMinutes: 5 });
    
    try {
        const userInfo = await chrome.identity.getProfileUserInfo({ accountStatus: "ANY" });
        const email = userInfo.email || "anonymous@student.local";
        
        const encoder = new TextEncoder();
        const data = encoder.encode(email);
        const hashBuffer = await crypto.subtle.digest('SHA-256', data);
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        const studentHash = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');

        const storage = await chrome.storage.local.get('localVersion');
        await chrome.storage.local.set({ 
            studentHash: studentHash, 
            localVersion: storage.localVersion || 0 
        });
        
        console.log("✅ Student ID securely hashed and stored:", studentHash);
        
        const isRegistered = await performHandshake(studentHash);
        if (isRegistered) {
            syncRules();
        }
        
    } catch (error) {
        console.error("❌ Failed to hash identity:", error);
    }
});

chrome.runtime.onStartup.addListener(async () => {
    console.log("🚀 Chrome started. Performing security handshake...");
    const data = await chrome.storage.local.get('studentHash');
    if (data.studentHash) {
        const isRegistered = await performHandshake(data.studentHash);
        if (isRegistered) {
            syncRules();
        }
    }
});

function formatDnrRules(dbRules) {
    return dbRules.map(rule => {
        const isAllow = rule.action === 'allow';
        let calculatedPriority = isAllow ? 20 : 10;
        
        if (rule.match_type === 'path') {
            calculatedPriority += 20; 
        } else if (rule.match_type === 'regex') {
            calculatedPriority += 40; 
        }
        
        let condition = {
            resourceTypes: ["main_frame", "sub_frame", "script", "xmlhttprequest", "ping"]
        };

        if (rule.match_type === 'regex') {
            condition.regexFilter = rule.target;
        } else if (rule.match_type === 'path') {
            condition.urlFilter = `||${rule.target}*`; 
        } else {
            condition.urlFilter = `||${rule.target}^`; 
        }

        return {
            id: rule.id, 
            priority: calculatedPriority, 
            action: isAllow 
                ? { type: "allow" } 
                : { 
                    type: "redirect", 
                    redirect: { 
                        extensionPath: `/block.html?url=${encodeURIComponent(rule.target)}` 
                    } 
                },
            condition: condition
        };
    });
}

// The Core Sync Engine
async function syncRules() {
    console.log("🔄 Polling Cloudflare for rule updates...");
    
    // 🎯 FIX: Retrieve studentHash in addition to schoolId
    const data = await chrome.storage.local.get(['localVersion', 'schoolId', 'studentHash']);
    const currentVersion = data.localVersion || 0;
    const schoolId = data.schoolId || 1; 
    const studentHash = data.studentHash || "";

    try {
        const configUrl = chrome.runtime.getURL("config.json");
        const configRes = await fetch(configUrl);
        const config = await configRes.json();
        const baseUrl = config.workerUrl.endsWith('/') ? config.workerUrl.slice(0, -1) : config.workerUrl;

        // 🎯 FIX: Append studentHash to the query string
        const queryParams = `version=${currentVersion}&schoolId=${schoolId}&studentHash=${encodeURIComponent(studentHash)}`;
        const response = await fetch(`${baseUrl}/api/filter/sync?${queryParams}`);
        
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Server returned ${response.status}: ${errorText}`);
        }

        const result = await response.json();

        if (result.status === "up_to_date") {
            console.log("✅ Up to date at version:", result.version);
        } 
        else if (result.status === "delta_success") {
            console.log(`📦 Applying Delta: +${result.added.length} | -${result.removed.length}`);
            
            const newRules = formatDnrRules(result.added);
            
            await chrome.declarativeNetRequest.updateDynamicRules({
                addRules: newRules,
                removeRuleIds: result.removed
            });
            
            await chrome.storage.local.set({ localVersion: result.version });
            console.log(`✅ Delta applied successfully. Now at version ${result.version}`);
        }
        else if (result.status === "full_sync_required") {
            console.log("⚠️ Gap too large. Falling back to full sync...");
            
            // 🎯 FIX: Append studentHash to the full sync query as well
            const fullRes = await fetch(`${baseUrl}/api/filter/sync/full?schoolId=${schoolId}&studentHash=${encodeURIComponent(studentHash)}`);
            
            if (!fullRes.ok) {
                throw new Error(`Full Sync API failed with status ${fullRes.status}`);
            }
            
            const fullResult = await fullRes.json();

            if (fullResult.status === "full_success") {
                console.log(`📦 Applying Full Sync: ${fullResult.rules.length} rules`);
                
                const newRules = formatDnrRules(fullResult.rules);
                const existingRules = await chrome.declarativeNetRequest.getDynamicRules();
                const existingRuleIds = existingRules.map(r => r.id);
                
                await chrome.declarativeNetRequest.updateDynamicRules({
                    addRules: newRules,
                    removeRuleIds: existingRuleIds
                });
                
                await chrome.storage.local.set({ localVersion: fullResult.version });
                console.log(`✅ Full sync complete. Now at version ${fullResult.version}`);
            }
        }

    } catch (err) {
        console.error("❌ Sync failed. Will retry in 5 minutes.", err.message);
    }
}

chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === "syncGlassboxRules") {
        syncRules();
    }
});

// ==========================================
// 📨 MESSAGE LISTENERS
// ==========================================
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "force_sync") {
        console.log("📥 Received force_sync command from setup page. Executing immediate sync...");
        // 🎯 FIX: Correctly calls syncRules for the Filter Agent
        syncRules().then(() => {
            sendResponse({ success: true });
        });
        return true; 
    }
});

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        formatDnrRules,
        syncRules
    };
}