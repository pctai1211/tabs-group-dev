// Hàm lấy domain từ URL
// Hàm backport
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

function showStatus(message, type) {
    const status = document.getElementById('status');
    status.textContent = message;
    status.className = type;
    status.style.display = 'block';

    setTimeout(() => {
        status.style.display = 'none';
    }, 3000);
}

// Tìm group đã tồn tại của domain trong tất cả windows
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

async function groupTabsByDomain() {
    try {
        const currentWindow = await chrome.windows.getCurrent();
        const tabs = await chrome.tabs.query({ windowId: currentWindow.id });

        // Nhóm tab theo domain
        const domainMap = new Map();

        tabs.forEach(tab => {
            const domain = getDomain(tab.url);
            if (domain &&
                !tab.url.startsWith('chrome://') &&
                !tab.url.startsWith('chrome-extension://') &&
                !tab.url.startsWith('about:')) {
                if (!domainMap.has(domain)) {
                    domainMap.set(domain, []);
                }
                domainMap.get(domain).push(tab);
            }
        });

        let createdCount = 0;

        // Duyệt domain và tạo group
        for (const [domain, domainTabs] of domainMap.entries()) {
            if (domainTabs.length > 1) {
                // Kiểm tra xem có group sẵn không
                const groups = await chrome.tabGroups.query({ windowId: currentWindow.id });
                let existingGroup = null;

                for (const group of groups) {
                    const stored = await chrome.storage.local.get('group_' + group.id);
                    const groupDomain = stored['group_' + group.id];
                    if (groupDomain === domain) {
                        existingGroup = group;
                        break;
                    }
                }

                // Lọc tabs chưa được group hoặc thuộc group khác
                const tabsToGroup = domainTabs.filter(t => {
                    return t.groupId === -1 || (existingGroup && t.groupId !== existingGroup.id);
                });

                if (tabsToGroup.length === 0) continue;

                const tabIds = tabsToGroup.map(t => t.id);

                if (!existingGroup) {
                    // Tạo group mới
                    const groupId = await chrome.tabs.group({ tabIds });

                    // Lấy hoặc tạo persistent config
                    const persistentKey = 'persistentGroup_' + domain;
                    const stored = await chrome.storage.local.get(persistentKey);
                    const persistent = stored[persistentKey] || {
                        color: await getColorForDomain(domain),
                        collapsed: false,
                        tabs: []
                    };

                    await chrome.tabGroups.update(groupId, {
                        title: shortenDomain(domain),
                        color: persistent.color,
                        collapsed: persistent.collapsed
                    });

                    // Lưu thông tin group và persistent
                    const currentTabsInfo = domainTabs.map(t => ({ url: t.url, title: t.title }));
                    const mergedTabs = [...persistent.tabs];
                    currentTabsInfo.forEach(t => {
                        if (!mergedTabs.some(mt => mt.url === t.url)) mergedTabs.push(t);
                    });
                    persistent.tabs = mergedTabs;

                    await chrome.storage.local.set({
                        ['group_' + groupId]: domain,
                        [persistentKey]: persistent
                    });

                    createdCount++;
                } else {
                    // Thêm vào group có sẵn
                    await chrome.tabs.group({
                        tabIds,
                        groupId: existingGroup.id
                    });

                    // Cập nhật persistent storage
                    const persistentKey = 'persistentGroup_' + domain;
                    const stored = await chrome.storage.local.get(persistentKey);
                    const persistent = stored[persistentKey] || {
                        color: existingGroup.color,
                        collapsed: existingGroup.collapsed,
                        tabs: []
                    };

                    const currentTabsInfo = domainTabs.map(t => ({ url: t.url, title: t.title }));
                    const mergedTabs = [...persistent.tabs];
                    currentTabsInfo.forEach(t => {
                        if (!mergedTabs.some(mt => mt.url === t.url)) mergedTabs.push(t);
                    });
                    persistent.tabs = mergedTabs;

                    await chrome.storage.local.set({ [persistentKey]: persistent });
                }
            }
        }

        if (createdCount > 0) {
            showStatus(`✓ Đã tạo ${createdCount} nhóm tab`, 'success');
        } else {
            showStatus('Tất cả tabs đã được nhóm hoặc không đủ điều kiện', 'success');
        }

    } catch (error) {
        console.error('Error:', error);
        showStatus('❌ Có lỗi xảy ra: ' + error.message, 'error');
    }
}

// Hàm gỡ tất cả các nhóm
async function ungroupAllTabs() {
    try {
        const tabs = await chrome.tabs.query({ currentWindow: true });
        const groupedTabs = tabs.filter(tab => tab.groupId !== -1);

        if (groupedTabs.length > 0) {
            const tabIds = groupedTabs.map(tab => tab.id);
            await chrome.tabs.ungroup(tabIds);
            showStatus(`✓ Đã gỡ nhóm ${groupedTabs.length} tab`, 'success');
        } else {
            showStatus('Không có tab nào trong nhóm', 'error');
        }

    } catch (error) {
        console.error('Error:', error);
        showStatus('❌ Có lỗi xảy ra: ' + error.message, 'error');
    }
}

document.getElementById('groupBtn').addEventListener('click', groupTabsByDomain);
document.getElementById('ungroupBtn').addEventListener('click', ungroupAllTabs);

// Xử lý toggle tự động nhóm
const autoGroupToggle = document.getElementById('autoGroupToggle');
const restorePersistentToggle = document.getElementById('restorePersistentToggle');

// Lấy trạng thái từ storage
chrome.storage.local.get(['autoGroupEnabled', 'restorePersistentEnabled'], (result) => {
    if (result.autoGroupEnabled !== undefined) {
        autoGroupToggle.checked = result.autoGroupEnabled;
    } else {
        autoGroupToggle.checked = true;
    }

    if (result.restorePersistentEnabled !== undefined) {
        restorePersistentToggle.checked = result.restorePersistentEnabled;
    } else {
        restorePersistentToggle.checked = true;
    }
});

// Lắng nghe sự thay đổi toggle Auto Group
autoGroupToggle.addEventListener('change', async (e) => {
    const enabled = e.target.checked;

    // Lưu trạng thái vào storage
    await chrome.storage.local.set({ autoGroupEnabled: enabled });

    // Gửi message đến background script
    try {
        chrome.runtime.sendMessage({
            action: 'toggleAutoGroup',
            enabled: enabled
        }, (response) => {
            if (chrome.runtime.lastError) {
                console.log('Background script not ready yet');
            }
        });
    } catch (error) {
        console.log('Message sending failed:', error);
    }

    showStatus(
        enabled ? '✓ Đã bật tự động nhóm tab' : '✓ Đã tắt tự động nhóm tab',
        'success'
    );
});

restorePersistentToggle.addEventListener('change', async (e) => {
    const enabled = e.target.checked;

    await chrome.storage.local.set({ restorePersistentEnabled: enabled });

    try {
        chrome.runtime.sendMessage({
            action: 'toggleRestorePersistent',
            enabled: enabled
        }, (response) => {
            if (chrome.runtime.lastError) {
                console.log('Background script not ready yet');
            }
        });
    } catch (error) {
        console.log('Message sending failed:', error);
    }

    showStatus(
        enabled ? '✓ Đã bật khôi phục tabs' : '✓ Đã tắt khôi phục tabs',
        'success'
    );
});