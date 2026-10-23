let currentPublicPeriod = "24h";
let publicStreamers = [];
let publicGifts = [];

function fmtEUR(v) {
    return new Intl.NumberFormat("de-DE", { style: "currency", currency: "EUR" }).format(v || 0);
}

function fmtUSD(v) {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(v || 0);
}

function fmtNum(v) {
    return new Intl.NumberFormat("de-DE").format(v || 0);
}

function applyTheme(theme) {
    const normalized = theme === "light" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", normalized);
    try {
        localStorage.setItem("toktracker_theme", normalized);
    } catch (e) {}
    const btn = document.getElementById("btnThemeToggle");
    if (btn) {
        btn.textContent = normalized === "dark" ? "Theme: DARK" : "Theme: LIGHT";
    }
}

function switchPublicTab(tabId) {
    document.querySelectorAll(".tab-btn").forEach((btn) => {
        btn.classList.toggle("active", btn.getAttribute("data-tab") === tabId);
    });
    document.querySelectorAll(".tab-panel").forEach((panel) => {
        panel.classList.toggle("active", panel.id === tabId);
    });
}

async function loadPublicOverview() {
    try {
        const res = await fetch(`/api/public/overview?period=${encodeURIComponent(currentPublicPeriod)}`);
        if (!res.ok) return;
        const data = await res.json();

        const t = data.totals || {};
        document.getElementById("pubSumNetEur").textContent = fmtEUR(t.eur_net);
        document.getElementById("pubSumNetUsd").textContent = `${fmtUSD(t.usd_net)} USD`;
        document.getElementById("pubSumCoins").textContent = fmtNum(t.total_coins);
        document.getElementById("pubSumStreamersSub").textContent =
            `${fmtNum(t.streamer_count)} Streamer (${fmtNum(t.live_count)} LIVE)`;
        document.getElementById("pubSumGrossEur").textContent = fmtEUR(t.eur_gross);
        document.getElementById("pubSumGrossUsd").textContent = `${fmtUSD(t.usd_gross)} USD`;
        document.getElementById("pubSumGiftsSent").textContent = fmtNum(t.total_gifts_sent);
        document.getElementById("pubSumGiftEvents").textContent = `${fmtNum(t.gift_events_count)} Transaktionen`;

        document.getElementById("pubLiveCount").textContent = fmtNum(t.live_count || 0);
        document.getElementById("pubTotalStreamers").textContent = fmtNum(t.streamer_count || 0);
        document.getElementById("pubBadgeStreamers").textContent = fmtNum(t.streamer_count || 0);
        document.getElementById("pubBadgeGifts").textContent = fmtNum(t.gift_events_count || 0);

        const nowStr = new Date().toLocaleTimeString("de-DE", {
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
        });
        document.getElementById("pubLastUpdate").textContent = nowStr;

        if (data.rates) {
            const netPer1k = (data.rates.usd_per_diamond || 0.005) * 1000;
            const grossPer1k = (data.rates.gross_usd_per_coin || 0.0106) * 1000;
            const netEl = document.getElementById("pubRateNetInfo");
            const grossEl = document.getElementById("pubRateGrossInfo");
            const fxEl = document.getElementById("pubRateFxInfo");
            if (netEl) netEl.textContent = `${fmtUSD(netPer1k)} USD pro 1.000 Coins (~50 % Creator-Anteil)`;
            if (grossEl) grossEl.textContent = `${fmtUSD(grossPer1k)} USD pro 1.000 Coins`;
            if (fxEl) fxEl.textContent = String(data.rates.usd_to_eur_rate || 0.92);
        }

        publicStreamers = data.streamers || [];
        publicGifts = data.recent_gifts || [];

        renderPublicLeaderboard();
        renderPublicGifts();
    } catch (e) {
        console.error("Fehler beim Laden der öffentlichen Übersicht:", e);
    }
}

function renderPublicLeaderboard() {
    const tbody = document.getElementById("pubStreamerTableBody");
    const filterVal = (document.getElementById("pubInputStreamerFilter")?.value || "").trim().toLowerCase();
    const onlyLive = Boolean(document.getElementById("pubCheckOnlyLive")?.checked);

    const filtered = publicStreamers.filter((s) => {
        if (onlyLive && !s.is_live) return false;
        if (!filterVal) return true;
        const u = (s.username || "").toLowerCase();
        const d = (s.display_name || "").toLowerCase();
        return u.includes(filterVal) || d.includes(filterVal);
    });

    document.getElementById("pubStreamerTableMeta").textContent =
        `${filtered.length} von ${publicStreamers.length} Streamern`;

    if (filtered.length === 0) {
        tbody.innerHTML = `<tr><td colspan="10" class="muted">Keine Streamer für diese Filterauswahl gefunden.</td></tr>`;
        return;
    }

    tbody.innerHTML = filtered
        .map((s, idx) => {
            const rank = idx + 1;
            const rankClass = rank <= 3 && s.total_coins > 0 ? "top-rank" : "";

            let statusBadge = `<span class="status-tag">OFFLINE</span>`;
            if (s.is_live) {
                statusBadge = `<span class="status-tag live">● LIVE</span>`;
            } else if (s.is_tracking_active) {
                statusBadge = `<span class="status-tag polling">STANDBY · AUTO</span>`;
            }

            const topGift = s.top_gift
                ? `${s.top_gift.gift_name} (${fmtNum(s.top_gift.coins)})`
                : "-";
            const topGifter = s.top_gifter
                ? `@${s.top_gifter.sender_username} (${fmtNum(s.top_gifter.coins)})`
                : "-";

            return `
                <tr>
                    <td class="mono">
                        <span class="rank-badge ${rankClass}">#${rank}</span>
                    </td>
                    <td>
                        <strong><a href="#" onclick="showPublicStreamerDetail(${s.id}); return false;">${s.display_name || s.username}</a></strong>
                        <div class="mono muted">@${s.username}</div>
                    </td>
                    <td class="hide-sm">
                        ${statusBadge}
                    </td>
                    <td class="num-col hide-md">
                        <strong>${fmtNum(s.current_viewers || 0)}</strong>
                        <div class="muted">${fmtNum(s.follower_count || 0)} Follower</div>
                    </td>
                    <td class="num-col">
                        <strong>${fmtNum(s.total_coins)}</strong>
                        <div class="muted">${fmtNum(s.total_gifts_sent)} Gifts · ${fmtNum(s.unique_gifters)} Spender</div>
                    </td>
                    <td class="num-col"><strong>${fmtEUR(s.eur_net)}</strong></td>
                    <td class="num-col hide-sm">${fmtUSD(s.usd_net)}</td>
                    <td class="num-col hide-md">${fmtEUR(s.eur_gross)}</td>
                    <td class="mono hide-sm">
                        <div>Gift: ${topGift}</div>
                        <div class="muted">Spender: ${topGifter}</div>
                    </td>
                    <td>
                        <div class="action-group">
                            <button type="button" class="sm primary" onclick="showPublicStreamerDetail(${s.id})">Auswertung</button>
                            <a class="btn-link sm mono hide-sm" href="https://www.tiktok.com/@${encodeURIComponent(s.username)}/live" target="_blank" rel="noopener">TikTok ↗</a>
                        </div>
                    </td>
                </tr>
            `;
        })
        .join("");
}

function renderPublicGifts() {
    const tbody = document.getElementById("pubGiftLogBody");
    const filterVal = (document.getElementById("pubInputGiftFilter")?.value || "").trim().toLowerCase();

    const filtered = publicGifts.filter((g) => {
        if (!filterVal) return true;
        return (
            (g.streamer_username || "").toLowerCase().includes(filterVal) ||
            (g.sender_username || "").toLowerCase().includes(filterVal) ||
            (g.sender_nickname || "").toLowerCase().includes(filterVal) ||
            (g.gift_name || "").toLowerCase().includes(filterVal)
        );
    });

    if (filtered.length === 0) {
        tbody.innerHTML = `<tr><td colspan="7" class="muted">Keine Geschenke im gewählten Zeitraum.</td></tr>`;
        return;
    }

    tbody.innerHTML = filtered
        .map((g) => {
            const ts = (g.created_at || "").replace("T", " ");
            return `
                <tr>
                    <td class="mono muted">${ts}</td>
                    <td class="mono"><strong>@${g.streamer_username}</strong></td>
                    <td>
                        ${g.sender_nickname || g.sender_username}
                        <span class="mono muted hide-sm">(@${g.sender_username})</span>
                        ${g.is_super_fan ? `<span class="status-tag polling">SUPERFAN</span>` : ""}
                    </td>
                    <td class="hide-sm"><strong>${g.repeat_count}x</strong> ${g.gift_name}</td>
                    <td class="num-col"><strong>${fmtNum(g.total_coins)}</strong></td>
                    <td class="num-col"><strong>${fmtEUR(g.eur_net)}</strong></td>
                    <td class="num-col hide-sm">${fmtUSD(g.usd_net)}</td>
                </tr>
            `;
        })
        .join("");
}

async function showPublicStreamerDetail(streamerId) {
    const res = await fetch(
        `/api/public/streamers/${encodeURIComponent(streamerId)}?period=${encodeURIComponent(currentPublicPeriod)}`
    );
    if (!res.ok) return;
    const data = await res.json();
    const s = data.streamer;

    document.getElementById("pubDetailTitle").textContent =
        `Auswertung: ${s.display_name || s.username} (@${s.username})`;
    document.getElementById("pubDetailSubtitle").textContent =
        `Netto: ${fmtEUR(data.summary.eur_net)} (${fmtUSD(data.summary.usd_net)}) · Coins: ${fmtNum(data.summary.total_coins)} · Brutto: ${fmtEUR(data.summary.eur_gross)} · Geschenke: ${fmtNum(data.summary.total_gifts_sent)}`;

    const ttLink = document.getElementById("pubDetailTikTokLink");
    if (ttLink) {
        ttLink.href = `https://www.tiktok.com/@${encodeURIComponent(s.username)}/live`;
    }

    const giftsBody = document.getElementById("pubDetailGiftsBody");
    giftsBody.innerHTML =
        data.gift_breakdown.length === 0
            ? `<tr><td colspan="4" class="muted">Keine Geschenke im Zeitraum aufgezeichnet.</td></tr>`
            : data.gift_breakdown
                  .map(
                      (g) => `
                <tr>
                    <td><strong>${g.gift_name}</strong> <span class="mono muted">(${g.diamond_count})</span></td>
                    <td class="num-col">${fmtNum(g.total_quantity)}x</td>
                    <td class="num-col">${fmtNum(g.total_coins)}</td>
                    <td class="num-col"><strong>${fmtEUR(g.eur_net)}</strong></td>
                </tr>`
                  )
                  .join("");

    const giftersBody = document.getElementById("pubDetailGiftersBody");
    giftersBody.innerHTML =
        data.top_gifters.length === 0
            ? `<tr><td colspan="4" class="muted">Keine Spender im Zeitraum aufgezeichnet.</td></tr>`
            : data.top_gifters
                  .map(
                      (tg) => `
                <tr>
                    <td><strong>@${tg.sender_username}</strong> ${tg.is_super_fan ? `<span class="status-tag polling">SF</span>` : ""}</td>
                    <td class="num-col">${fmtNum(tg.gifts_sent)}</td>
                    <td class="num-col">${fmtNum(tg.total_coins)}</td>
                    <td class="num-col"><strong>${fmtEUR(tg.eur_net)}</strong></td>
                </tr>`
                  )
                  .join("");

    const sessBox = document.getElementById("pubDetailSessionsList");
    sessBox.innerHTML =
        (data.sessions || []).length === 0
            ? "Noch keine aufgezeichneten Live-Sessions."
            : data.sessions
                  .map(
                      (ss) =>
                          `#${ss.id} [${ss.status.toUpperCase()}] Start: ${(ss.started_at || "").replace("T", " ")} | Peak Viewers: ${fmtNum(ss.peak_viewers)} | Coins: ${fmtNum(ss.session_coins)} (${fmtEUR(ss.eur_net)})`
                  )
                  .join("<br/>");

    const box = document.getElementById("pubStreamerDetailBox");
    box.style.display = "block";
    box.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

document.addEventListener("DOMContentLoaded", () => {
    const currentTheme = document.documentElement.getAttribute("data-theme") || "dark";
    applyTheme(currentTheme);

    const themeBtn = document.getElementById("btnThemeToggle");
    if (themeBtn) {
        themeBtn.addEventListener("click", () => {
            const nextTheme =
                document.documentElement.getAttribute("data-theme") === "light" ? "dark" : "light";
            applyTheme(nextTheme);
        });
    }

    document.querySelectorAll(".tab-btn").forEach((btn) => {
        btn.addEventListener("click", () => {
            switchPublicTab(btn.getAttribute("data-tab"));
        });
    });

    loadPublicOverview();
    let publicTimer = null;
    function scheduleNextPublicOverview() {
        if (publicTimer) clearTimeout(publicTimer);
        const delay = document.hidden ? 30000 : 5000;
        publicTimer = setTimeout(async () => {
            if (!document.hidden) {
                await loadPublicOverview();
            }
            scheduleNextPublicOverview();
        }, delay);
    }
    scheduleNextPublicOverview();

    document.addEventListener("visibilitychange", () => {
        if (!document.hidden) {
            loadPublicOverview();
            scheduleNextPublicOverview();
        }
    });

    document.getElementById("pubPeriodSelect").addEventListener("change", (e) => {
        currentPublicPeriod = e.target.value;
        loadPublicOverview();
    });

    document.getElementById("pubBtnRefresh").addEventListener("click", loadPublicOverview);
    document.getElementById("pubInputStreamerFilter").addEventListener("input", renderPublicLeaderboard);
    document.getElementById("pubCheckOnlyLive").addEventListener("change", renderPublicLeaderboard);
    document.getElementById("pubInputGiftFilter").addEventListener("input", renderPublicGifts);

    document.getElementById("pubBtnCloseDetail").addEventListener("click", () => {
        document.getElementById("pubStreamerDetailBox").style.display = "none";
    });
});
