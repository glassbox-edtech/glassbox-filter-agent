chrome.runtime.onInstalled.addListener(async () => {
    console.log("Glassbox Installed. Initializing Engine...");

    // 1. Create our recurring polling alarm (runs every 5 minutes)
    chrome.alarms.create("syncGlassboxRules", { periodInMinutes: 5 });
    
    // ... identity hashing stuff ...
    try {
        const userInfo = await chrome.identity.getProfileUserInfo({ accountStatus: "ANY" });
        const email = userInfo.email || "anonymous@student.local";
        
        const encoder = new TextEncoder();
        const data = encoder.encode(email);
        const hashBuffer = await crypto.subtle.digest('SHA-256', data);
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        const studentHash = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');

        await chrome.storage.local.set({ studentHash, localVersion: 0 });
        console.log("✅ Student ID securely hashed and stored:", studentHash);
        
    } catch (error) {
        console.error("❌ Failed to hash identity:", error);
    }
});

// 2. Listen for the alarm to trigger our Delta Sync
chrome.alarms.onAlarm.addListener(async (alarm) => {
    if (alarm.name === "syncGlassboxRules") {
        console.log("🔄 Polling Cloudflare for rule updates...");
        
        const data = await chrome.storage.local.get('localVersion');
        const currentVersion = data.localVersion || 0;

        try {
            // Fetch the central config file to get the dynamic URL
            const configUrl = chrome.runtime.getURL("config.json");
            const configRes = await fetch(configUrl);
            const config = await configRes.json();

            // Send our current version to the Delta API
            const response = await fetch(`${config.workerUrl}/api/sync?version=${currentVersion}`);
            const result = await response.json();

            if (result.status === "up_to_date") {
                console.log("✅ Up to date at version:", result.version);
            } 
            else if (result.status === "delta_success") {
                console.log(`📦 Applying Delta: +${result.added.length} | -${result.removed.length}`);
                
                // --- Next phase: Convert result.added into DNR rules here! ---
                
                // Save the new version number
                await chrome.storage.local.set({ localVersion: result.version });
            }
            else if (result.status === "full_sync_required") {
                console.log("⚠️ Gap too large. Falling back to full sync...");
                // --- Next phase: Fetch /api/sync/full here ---
            }

        } catch (err) {
            console.error("❌ Sync failed. Will retry in 5 minutes.", err);
        }
    }
});
