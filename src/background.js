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
            // Open the setup.html page so the student can select their school
            chrome.tabs.create({ url: chrome.runtime.getURL("setup.html") });
            return false;
        } else if (res.ok) {
            const data = await res.json();
            // Lock the school ID locally for fast retrieval during syncs
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

    // 1. Create our recurring polling alarm (runs every 5 minutes)
    chrome.alarms.create("syncGlassboxRules", { periodInMinutes: 5 });
    
    // 2. Identity Hashing Setup
    try {
        const userInfo = await chrome.identity.getProfileUserInfo({ accountStatus: "ANY" });
        const email = userInfo.email || "anonymous@student.local";
        
        const encoder = new TextEncoder();
        const data = encoder.encode(email);
        const hashBuffer = await crypto.subtle.digest('SHA-256', data);
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        const studentHash = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');

        // Store the hash. We use '|| 0' so we don't overwrite localVersion if it already exists
        const storage = await chrome.storage.local.get('localVersion');
        await chrome.storage.local.set({ 
            studentHash: studentHash, 
            localVersion: storage.localVersion || 0 
        });
        
        console.log("✅ Student ID securely hashed and stored:", studentHash);
        
        // 3. Perform Handshake & Sync
        const isRegistered = await performHandshake(studentHash);
        if (isRegistered) {
            syncRules();
        }
        
    } catch (error) {
        console.error("❌ Failed to hash identity:", error);
    }
});

// Run handshake every time Chrome starts up
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

// Helper function to map Database rules to Chrome DNR format
function formatDnrRules(dbRules) {
    return dbRules.map(rule => {
        const isAllow = rule.action === 'allow';
        
        // 🎯 PRIORITY HIERARCHY FIX
        // Base Priorities: Domain Block = 10, Domain Allow = 20
        let calculatedPriority = isAllow ? 20 : 10;
        
        // Specificity Modifiers: Paths logically outrank Domains
        if (rule.match_type === 'path') {
            calculatedPriority += 20; // Path Block = 30, Path Allow = 40
        } else if (rule.match_type === 'regex') {
            calculatedPriority += 40; // Regex Block = 50, Regex Allow = 60
        }
        
        // 🔄 SCHEMA UPDATE: Dynamically build the condition based on match_type
        let condition = {
            resourceTypes: ["main_frame", "sub_frame", "script", "xmlhttprequest", "ping"]
        };

        if (rule.match_type === 'regex') {
            // 🛡️ ADVANCED REGEX BLOCKING
            condition.regexFilter = rule.target;
        } else if (rule.match_type === 'path') {
            // Path uses '*' to wildcard everything after the specified path
            condition.urlFilter = `||${rule.target}*`; 
        } else {
            // Default (domain/host) uses '^' to anchor the hostname
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
                        // Dynamically append the URI encoded target so block.html can pre-fill the form
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
    
    // 🎯 FIX: Retrieve the locked schoolId from local storage
    const data = await chrome.storage.local.get(['localVersion', 'schoolId']);
    const currentVersion = data.localVersion || 0;
    const schoolId = data.schoolId || 1; // Default to 1 (DEFAULT school)

    try {
        // Fetch the central config file to get the dynamic URL
        const configUrl = chrome.runtime.getURL("config.json");
        const configRes = await fetch(configUrl);
        const config = await configRes.json();

        // Clean up the URL by stripping trailing slashes
        const baseUrl = config.workerUrl.endsWith('/') ? config.workerUrl.slice(0, -1) : config.workerUrl;

        // 🎯 FIX: Append schoolId to the polling URL
        const response = await fetch(`${baseUrl}/api/filter/sync?version=${currentVersion}&schoolId=${schoolId}`);
        
        // Check if the server returned an error (like 404 Not Found) before parsing JSON
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
            
            // Convert database rules to Chrome rules
            const newRules = formatDnrRules(result.added);
            
            // Apply updates directly to Chrome's network engine
            await chrome.declarativeNetRequest.updateDynamicRules({
                addRules: newRules,
                removeRuleIds: result.removed
            });
            
            // Save the new version number
            await chrome.storage.local.set({ localVersion: result.version });
            console.log(`✅ Delta applied successfully. Now at version ${result.version}`);
        }
        else if (result.status === "full_sync_required") {
            console.log("⚠️ Gap too large. Falling back to full sync...");
            
            // 🎯 FIX: Append schoolId to the fallback fetch URL
            const fullRes = await fetch(`${baseUrl}/api/filter/sync/full?schoolId=${schoolId}`);
            
            if (!fullRes.ok) {
                throw new Error(`Full Sync API failed with status ${fullRes.status}`);
            }
            
            const fullResult = await fullRes.json();

            if (fullResult.status === "full_success") {
                console.log(`📦 Applying Full Sync: ${fullResult.rules.length} rules`);
                
                // 1. Convert new rules
                const newRules = formatDnrRules(fullResult.rules);
                
                // 2. Get existing dynamic rule IDs so we can wipe them clean
                const existingRules = await chrome.declarativeNetRequest.getDynamicRules();
                const existingRuleIds = existingRules.map(r => r.id);
                
                // 3. Wipe old rules and insert new ones simultaneously to prevent browsing interruptions
                await chrome.declarativeNetRequest.updateDynamicRules({
                    addRules: newRules,
                    removeRuleIds: existingRuleIds
                });
                
                // 4. Update local version
                await chrome.storage.local.set({ localVersion: fullResult.version });
                console.log(`✅ Full sync complete. Now at version ${fullResult.version}`);
            }
        }

    } catch (err) {
        console.error("❌ Sync failed. Will retry in 5 minutes.", err.message);
    }
}

// Listen for the alarm to trigger our Sync Engine
chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === "syncGlassboxRules") {
        syncRules();
    }
});

// ==========================================
// 🧪 TESTING EXPORTS
// ==========================================
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        formatDnrRules,
        syncRules
    };
}