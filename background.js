// Lưu trạng thái bật/tắt tự động nhóm main
let autoGroupEnabled = true;
let restorePersistentEnabled = true;

// Hàm lấy domain từ URL php7 no php7
function getDomain(url) {
    try {
        const urlObj = new URL(url);
        let host = urlObj.hostname;

        const removePrefixes = ["lab.", "imt.", "patients.", "www."];

        removePrefixes.forEach(prefix => {
            if (host.startsWith(prefix)) {
                host = host.replace(prefix, "");
            }
        });

        return host;
    } catch (e) {
        return null;
    }
}

function shortenDomain(domain) {
    if (!domain) return "";
    return domain.split('.')[0].length > 6
        ? domain.split('.')[0].substring(0, 6)
        : domain.split('.')[0];
}

async function getColorForDomain(domain) {
    const colors = ['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange'];
    const key = 'domainColor_' + domain;
    const stored = await chrome.storage.local.get(key);
    if (stored[key]) {
        return stored[key];
    }
    const all = await chrome.storage.local.get(null);
    const usedColors = Object.values(all)
        .filter(v => colors.includes(v));

    let newColor = null;
    for (const c of colors) {
        if (!usedColors.includes(c)) {
            newColor = c;
            break;
        }
    }

    if (!newColor) {
        newColor = colors[Math.floor(Math.random() * colors.length)];
    }

    await chrome.storage.local.set({ [key]: newColor });

    return newColor;
}

// Hàm tìm group đã tồn tại của domain này trong TẤT CẢ windows
async function findExistingGroupAcrossWindows(domain) {
    const allWindows = await chrome.windows.getAll();

    for (const window of allWindows) {
        const groups = await chrome.tabGroups.query({ windowId: window.id });

        for (const group of groups) {
            const stored = await chrome.storage.local.get('group_' + group.id);
            const groupDomain = stored['group_' + group.id];
            if (groupDomain === domain) {
                return {
                    group: group,
                    windowId: window.id
                };
            }
        }
    }

    return null;
}

async function groupTabByDomain(tab) {
    if (!autoGroupEnabled) return;

    try {
        const domain = getDomain(tab.url);

        if (!domain ||
            tab.url.startsWith('chrome://') ||
            tab.url.startsWith('chrome-extension://') ||
            tab.url.startsWith('about:') ||
            tab.url === 'chrome://newtab/' ||
            domain === 'newtab') {
            return;
        }

        // Đếm tổng số tabs cùng domain trên TẤT CẢ windows
        const allWindows = await chrome.windows.getAll();
        let totalSameDomainTabs = 0;

        for (const window of allWindows) {
            const windowTabs = await chrome.tabs.query({ windowId: window.id });
            const count = windowTabs.filter(t => {
                const tDomain = getDomain(t.url);
                return tDomain === domain &&
                    !t.url.startsWith('chrome://') &&
                    !t.url.startsWith('chrome-extension://') &&
                    !t.url.startsWith('about:');
            }).length;
            totalSameDomainTabs += count;
        }

        // Nếu chỉ có 1 tab duy nhất của domain này trên tất cả windows, không group
        if (totalSameDomainTabs < 2) {
            return;
        }

        // Tìm group đã tồn tại trong tất cả windows
        const existingGroupInfo = await findExistingGroupAcrossWindows(domain);

        // Nếu tìm thấy group ở window khác, chuyển tab về window đó
        if (existingGroupInfo && existingGroupInfo.windowId !== tab.windowId) {

            await chrome.tabs.move(tab.id, {
                windowId: existingGroupInfo.windowId,
                index: -1
            });

            await chrome.tabs.update(tab.id, { active: true });

            await chrome.tabs.group({
                tabIds: [tab.id],
                groupId: existingGroupInfo.group.id
            });

            return;
        }

        // Nếu có ít nhất 1 tab cùng domain ở window khác (nhưng không có group), chuyển sang đó
        for (const window of allWindows) {
            if (window.id === tab.windowId) continue;

            const windowTabs = await chrome.tabs.query({ windowId: window.id });
            const sameDomainTab = windowTabs.find(t => {
                const tDomain = getDomain(t.url);
                return tDomain === domain &&
                    !t.url.startsWith('chrome://') &&
                    !t.url.startsWith('chrome-extension://') &&
                    !t.url.startsWith('about:');
            });

            if (sameDomainTab) {
                console.log(`Found tab with domain ${domain} in window ${window.id}, moving and grouping...`);

                await chrome.tabs.move(tab.id, {
                    windowId: window.id,
                    index: -1
                });
                await chrome.tabs.update(tab.id, { active: true });
                await chrome.windows.update(window.id, { focused: true });

                // Lấy lại tất cả tabs cùng domain trong window đích
                const targetWindowTabs = await chrome.tabs.query({ windowId: window.id });
                const tabsToGroup = targetWindowTabs.filter(t => {
                    const tDomain = getDomain(t.url);
                    return tDomain === domain &&
                        !t.url.startsWith('chrome://') &&
                        !t.url.startsWith('chrome-extension://') &&
                        !t.url.startsWith('about:');
                });

                if (tabsToGroup.length >= 2) {
                    const tabIds = tabsToGroup.map(t => t.id);
                    const groupId = await chrome.tabs.group({ tabIds });

                    await chrome.tabGroups.update(groupId, {
                        title: shortenDomain(domain),
                        color: await getColorForDomain(domain),
                        collapsed: false
                    });

                    await chrome.storage.local.set({
                        ['group_' + groupId]: domain
                    });
                }
                return;
            }
        }

        // Xử lý trong cùng window hiện tại
        const allTabs = await chrome.tabs.query({ windowId: tab.windowId });
        const sameDomainTabs = allTabs.filter(t => {
            const tDomain = getDomain(t.url);
            return tDomain === domain &&
                !t.url.startsWith('chrome://') &&
                !t.url.startsWith('chrome-extension://') &&
                !t.url.startsWith('about:');
        });

        if (sameDomainTabs.length < 2) {
            return;
        }

        // Tìm group đã tồn tại trong window hiện tại
        const groups = await chrome.tabGroups.query({ windowId: tab.windowId });
        let existingGroup = null;

        for (const group of groups) {
            const stored = await chrome.storage.local.get('group_' + group.id);
            const groupDomain = stored['group_' + group.id];
            if (groupDomain === domain) {
                existingGroup = group;
                break;
            }
        }

        const tabsToGroup = sameDomainTabs.filter(t => {
            return t.groupId === -1 || (existingGroup && t.groupId !== existingGroup.id);
        });

        if (tabsToGroup.length === 0) {
            return;
        }

        const tabIds = tabsToGroup.map(t => t.id);

        if (!existingGroup) {
            const groupId = await chrome.tabs.group({ tabIds });

            await chrome.tabGroups.update(groupId, {
                title: shortenDomain(domain),
                color: await getColorForDomain(domain),
                collapsed: false
            });

            await chrome.storage.local.set({
                ['group_' + groupId]: domain
            });

        } else {
            await chrome.tabs.group({
                tabIds,
                groupId: existingGroup.id
            });
        }

    } catch (error) {
        console.error('Error grouping tab:', error);
    }
}

const restoringDomains = new Set();

async function restorePersistentGroup(tab) {
    if (!autoGroupEnabled || !restorePersistentEnabled) return;

    const domain = getDomain(tab.url);
    if (!domain) return;
    if (restoringDomains.has(domain)) {
        return;
    }

    const persistentKey = 'persistentGroup_' + domain;
    const stored = await chrome.storage.local.get(persistentKey);
    const persistent = stored[persistentKey];

    if (!persistent) return;

    const existingGroupInfo = await findExistingGroupAcrossWindows(domain);

    if (existingGroupInfo) {
        return;
    }

    // Kiểm tra xem có tab đơn lẻ cùng domain ở window khác không
    const allWindows = await chrome.windows.getAll();
    for (const window of allWindows) {
        if (window.id === tab.windowId) continue;

        const windowTabs = await chrome.tabs.query({ windowId: window.id });
        const sameDomainTab = windowTabs.find(t => {
            const tDomain = getDomain(t.url);
            return tDomain === domain &&
                !t.url.startsWith('chrome://') &&
                !t.url.startsWith('chrome-extension://') &&
                !t.url.startsWith('about:');
        });

        if (sameDomainTab) {
            return;
        }
    }

    // Kiểm tra xem có group trong window hiện tại không
    const groups = await chrome.tabGroups.query({ windowId: tab.windowId });
    for (const group of groups) {
        const stored = await chrome.storage.local.get('group_' + group.id);
        const groupDomain = stored['group_' + group.id];
        if (groupDomain === domain) {
            return;
        }
    }
    restoringDomains.add(domain);

    try {
        // Restore các tabs từ persistent storage
        const allTabs = await chrome.tabs.query({ windowId: tab.windowId });
        const existingUrls = allTabs.map(t => t.url);

        const urlsToOpen = persistent.tabs.map(t => t.url).filter(url => !existingUrls.includes(url));

        // Nếu không có URL mới để mở và chỉ có 1 tab, không tạo group
        if (urlsToOpen.length === 0) {
            const sameDomainTabs = allTabs.filter(t => getDomain(t.url) === domain);
            if (sameDomainTabs.length < 2) {
                restoringDomains.delete(domain);
                return;
            }
        }

        for (const url of urlsToOpen) {
            await chrome.tabs.create({ url, windowId: tab.windowId, active: false });
        }

        await new Promise(resolve => setTimeout(resolve, 100));

        const sameDomainTabs = await chrome.tabs.query({ windowId: tab.windowId });
        const tabIdsToGroup = sameDomainTabs.filter(t => getDomain(t.url) === domain).map(t => t.id);

        if (tabIdsToGroup.length > 0) {
            const groupId = await chrome.tabs.group({ tabIds: tabIdsToGroup });
            await chrome.tabGroups.update(groupId, {
                title: shortenDomain(domain),
                color: persistent.color,
                collapsed: persistent.collapsed
            });

            let allStorage = await chrome.storage.local.get(null);
            for (const key in allStorage) {
                if (key.startsWith("group_") && allStorage[key] === domain) {
                    await chrome.storage.local.remove(key);
                }
            }
            await chrome.storage.local.set({ ['group_' + groupId]: domain });
            await chrome.storage.local.remove(persistentKey);
        }
    } catch (error) {
        console.error(`Error restoring group for ${domain}:`, error);
    } finally {
        setTimeout(() => {
            restoringDomains.delete(domain);
        }, 2000);
    }
}

async function checkAndUngroupIfNeeded(groupId) {
    try {
        const tabsInGroup = await chrome.tabs.query({ groupId: groupId });

        if (tabsInGroup.length <= 1) {
            const tabIds = tabsInGroup.map(t => t.id);
            if (tabIds.length > 0) {
                await chrome.tabs.ungroup(tabIds);
            }
        }
    } catch (error) {
        console.error('Error ungrouping tab:', error);
    }
}

// Lắng nghe khi có tab bị xóa để cache thông tin group
chrome.tabs.onRemoved.addListener(async (tabId, removeInfo) => {
    try {
        const groups = await chrome.tabGroups.query({ windowId: removeInfo.windowId });
        for (const group of groups) {
            await checkAndUngroupIfNeeded(group.id);
        }
    } catch (error) {
        console.error('Error handling tab removal:', error);
    }
});

chrome.runtime.onInstalled.addListener(() => {
    chrome.contextMenus.create({
        id: "saveGroupForLater",
        title: "Save group for later",
        contexts: ["page"],
        documentUrlPatterns: ["chrome://newtab/*", "https://*/*", "http://*/*"]
    });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
    if (info.menuItemId === "saveGroupForLater" && tab.groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE) {
        try {
            const group = await chrome.tabGroups.get(tab.groupId);
            const tabs = await chrome.tabs.query({ groupId: tab.groupId });

            const domain = getDomain(tab.url);

            const persistentKey = 'persistentGroup_' + domain;
            const persistent = {
                color: group.color,
                collapsed: group.collapsed,
                title: group.title,
                savedAt: Date.now(),
                tabs: tabs.map(t => ({ url: t.url, title: t.title }))
            };

            await chrome.storage.local.set({ [persistentKey]: persistent });

            chrome.notifications.create({
                type: 'basic',
                iconUrl: 'icon.png',
                title: '✅ Group Saved',
                message: `Saved "${group.title || domain}" with ${tabs.length} tabs`
            });

        } catch (error) {
            console.error('Error saving group:', error);
        }
    }
});

// Lắng nghe khi tab được di chuyển ra khỏi group
chrome.tabs.onDetached.addListener(async (tabId, detachInfo) => {
    try {
        const groups = await chrome.tabGroups.query({ windowId: detachInfo.oldWindowId });
        for (const group of groups) {
            await checkAndUngroupIfNeeded(group.id);
        }
    } catch (error) {
        console.error('Error handling tab detachment:', error);
    }
});

// Lắng nghe khi URL của tab thay đổi
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
    if (changeInfo.url) {
        await restorePersistentGroup(tab);
        await groupTabByDomain(tab);
    }
    else if (changeInfo.status === 'complete' && tab.url) {
        await groupTabByDomain(tab);
    }
});

// Lắng nghe tin nhắn từ popup
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'toggleAutoGroup') {
        autoGroupEnabled = message.enabled;
        sendResponse({ success: true });
    } else if (message.action === 'toggleRestorePersistent') {
        restorePersistentEnabled = message.enabled;
        sendResponse({ success: true });
    } else if (message.action === 'getStatus') {
        sendResponse({
            autoGroupEnabled: autoGroupEnabled,
            restorePersistentEnabled: restorePersistentEnabled
        });
    }
    return true;
});

// Khôi phục trạng thái khi extension khởi động/cài đặt
async function initializeAutoGroupState() {
    const result = await chrome.storage.local.get(['autoGroupEnabled', 'restorePersistentEnabled']);

    if (result.autoGroupEnabled !== undefined) {
        autoGroupEnabled = result.autoGroupEnabled;
    } else {
        autoGroupEnabled = true;
        await chrome.storage.local.set({ autoGroupEnabled: true });
    }

    if (result.restorePersistentEnabled !== undefined) {
        restorePersistentEnabled = result.restorePersistentEnabled;
    } else {
        restorePersistentEnabled = true;
        await chrome.storage.local.set({ restorePersistentEnabled: true });
    }
}

// Khởi tạo khi extension được cài đặt
chrome.runtime.onInstalled.addListener(async () => {
    await initializeAutoGroupState();
});

// Khởi tạo ngay khi service worker khởi động
initializeAutoGroupState();