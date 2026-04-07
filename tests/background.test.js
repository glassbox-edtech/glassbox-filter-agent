import { describe, it, expect, vi, beforeEach } from 'vitest';
import { formatDnrRules, syncRules } from '../src/background.js';

describe('DNR Rule Compilation (formatDnrRules)', () => {
    it('should correctly format Domain rules (Priority 10 & 20)', () => {
        const dbRules = [
            { id: 1, target: 'badsite.com', match_type: 'domain', action: 'block' },
            { id: 2, target: 'goodsite.com', match_type: 'domain', action: 'allow' }
        ];
        
        const dnrRules = formatDnrRules(dbRules);
        
        expect(dnrRules[0].priority).toBe(10);
        expect(dnrRules[0].condition.urlFilter).toBe('||badsite.com^');
        expect(dnrRules[0].action.type).toBe('redirect');

        expect(dnrRules[1].priority).toBe(20);
        expect(dnrRules[1].condition.urlFilter).toBe('||goodsite.com^');
        expect(dnrRules[1].action.type).toBe('allow');
    });

    it('should correctly format Path rules (Priority 30 & 40)', () => {
        const dbRules = [
            { id: 3, target: 'reddit.com/r/games', match_type: 'path', action: 'block' }
        ];
        const dnrRules = formatDnrRules(dbRules);
        
        expect(dnrRules[0].priority).toBe(30);
        expect(dnrRules[0].condition.urlFilter).toBe('||reddit.com/r/games*');
    });

    it('should correctly format Regex rules (Priority 50 & 60)', () => {
        const dbRules = [
            { id: 4, target: '^https?://.*badword.*', match_type: 'regex', action: 'block' }
        ];
        const dnrRules = formatDnrRules(dbRules);
        
        expect(dnrRules[0].priority).toBe(50);
        expect(dnrRules[0].condition.regexFilter).toBe('^https?://.*badword.*');
        expect(dnrRules[0].condition.urlFilter).toBeUndefined(); // Regex shouldn't have a urlFilter
    });

    it('should correctly URI-encode the redirect extensionPath', () => {
        const dbRules = [{ id: 5, target: 'site.com/search?q=bad words', match_type: 'path', action: 'block' }];
        const dnrRules = formatDnrRules(dbRules);
        
        // Ensure spaces are converted to %20 so the HTML block page doesn't break
        expect(dnrRules[0].action.redirect.extensionPath).toContain('site.com%2Fsearch%3Fq%3Dbad%20words');
    });
});

describe('The Sync Engine (syncRules)', () => {
    beforeEach(() => {
        // Reset mocks
        vi.clearAllMocks();
        
        // Mock Chrome Storage defaults
        global.chrome.storage.local.get.mockResolvedValue({ localVersion: 100 });
        global.chrome.declarativeNetRequest.getDynamicRules.mockResolvedValue([{ id: 1 }, { id: 2 }]);
        
        // Default Fetch Mock Router
        global.fetch.mockImplementation(async (url) => {
            if (url.includes('config.json')) {
                return { ok: true, json: async () => ({ workerUrl: 'https://api.test.com' }) };
            }
            return { ok: true, json: async () => ({ status: "up_to_date", version: 100 }) };
        });
    });

    it('Scenario A: Should do nothing if status is up_to_date', async () => {
        await syncRules();
        expect(global.chrome.declarativeNetRequest.updateDynamicRules).not.toHaveBeenCalled();
    });

    it('Scenario B: Should process Delta Updates correctly', async () => {
        global.fetch.mockImplementation(async (url) => {
            if (url.includes('config.json')) return { ok: true, json: async () => ({ workerUrl: 'https://api.test.com' }) };
            if (url.includes('/api/filter/sync')) {
                return {
                    ok: true,
                    json: async () => ({
                        status: "delta_success",
                        version: 105,
                        added: [{ id: 99, target: 'newbadsite.com', match_type: 'domain', action: 'block' }],
                        removed: [5, 6]
                    })
                };
            }
        });

        await syncRules();

        // Ensure Chrome DNR engine was called with the exactly right payload
        expect(global.chrome.declarativeNetRequest.updateDynamicRules).toHaveBeenCalledWith(
            expect.objectContaining({
                removeRuleIds: [5, 6],
                addRules: expect.arrayContaining([
                    expect.objectContaining({ id: 99 })
                ])
            })
        );
        
        // Ensure version bumped
        expect(global.chrome.storage.local.set).toHaveBeenCalledWith({ localVersion: 105 });
    });

    it('Scenario C: Should handle Full Sync fallback and wipe old rules', async () => {
        global.fetch.mockImplementation(async (url) => {
            if (url.includes('config.json')) return { ok: true, json: async () => ({ workerUrl: 'https://api.test.com' }) };
            
            // First hit delta...
            if (url.includes('/api/filter/sync?')) {
                return { ok: true, json: async () => ({ status: "full_sync_required" }) };
            }
            // ...which should force a second hit to full!
            if (url.includes('/api/filter/sync/full')) {
                return {
                    ok: true,
                    json: async () => ({
                        status: "full_success",
                        version: 200,
                        rules: [{ id: 88, target: 'fullbadsite.com', match_type: 'domain', action: 'block' }]
                    })
                };
            }
        });

        await syncRules();

        // Ensure DNR engine wiped the existing rules ([1, 2]) and installed the new one (88)
        expect(global.chrome.declarativeNetRequest.updateDynamicRules).toHaveBeenCalledWith({
            removeRuleIds: [1, 2],
            addRules: expect.arrayContaining([expect.objectContaining({ id: 88 })])
        });
    });

    it('Scenario D: Should catch network failures safely without crashing', async () => {
        // Force the fetch to throw a simulated Wi-Fi disconnect error
        global.fetch.mockRejectedValue(new Error("Network connection lost"));
        
        // This shouldn't throw an unhandled promise rejection
        await expect(syncRules()).resolves.toBeUndefined();
        
        // Ensure DNR rules were not touched
        expect(global.chrome.declarativeNetRequest.updateDynamicRules).not.toHaveBeenCalled();
    });
});