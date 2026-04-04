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
        
        // 3. Trigger an immediate sync right after installation
        syncRules();
        
    } catch (error) {
        console.error("❌ Failed to hash identity:", error);
    }
});

// Helper function to map Database rules to Chrome DNR format
function formatDnrRules(dbRules) {
    return dbRules.map(rule => {
        const isAllow = rule.action === 'allow';
        
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
            priority: isAllow ? 2 : 1, 
            action: isAllow 
                ? { type: "allow" } 
                : { type: "redirect", redirect: { extensionPath: "/block.html" } },
            condition: condition
        };
    });
}

// The Core Sync Engine
async function syncRules() {
    console.log("🔄 Polling Cloudflare for rule updates...");
    
    const data = await chrome.storage.local.get('localVersion');
    const currentVersion = data.localVersion || 0;

    try {
        // Fetch the central config file to get the dynamic URL
        const configUrl = chrome.runtime.getURL("config.json");
        const configRes = await fetch(configUrl);
        const config = await configRes.json();

        // 🛠️ FIX 1: Clean up the URL by stripping trailing slashes
        const baseUrl = config.workerUrl.endsWith('/') ? config.workerUrl.slice(0, -1) : config.workerUrl;

        // Send our current version to the Delta API (Updated Route!)
        const response = await fetch(`${baseUrl}/api/filter/sync?version=${currentVersion}`);
        
        // 🛠️ FIX 2: Check if the server returned an error (like 404 Not Found) before parsing JSON
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
            
            // Fetch the entire active ruleset from the Cloudflare KV cache (Updated Route!)
            const fullRes = await fetch(`${baseUrl}/api/filter/sync/full`);
            
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
