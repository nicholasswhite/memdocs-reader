(() => {
  "use strict";

  const PAGE_SIZE = 20;
  const KINDS = {
    updated: "Article updated",
    new: "Newly discovered",
    moved: "Article moved",
    removed: "Article removed",
    media: "Media updated",
    minor: "Minor edit"
  };
  // Keep the comparison algorithm testable without a browser or feed request.
  if (typeof document === "undefined") {
    if (typeof module !== "undefined") module.exports = { diffWords, comparisonLines };
    return;
  }
  const el = Object.fromEntries([
    "publication", "publication-text", "filters", "query", "product", "platform", "kind", "minor", "reset",
    "results", "loading", "error", "retry", "empty", "empty-description", "empty-reset", "feed", "pagination",
    "page-count", "load-more", "feed-window", "baseline-note", "history-link", "archive-link"
  ].map(id => [id, document.getElementById(id)]));
  const state = { updates: [], filtered: [], limit: PAGE_SIZE, open: new Set(), loading: false };
  const dateFormat = new Intl.DateTimeFormat("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "America/New_York" });
  const publishedFormat = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/New_York", timeZoneName: "short" });
  const number = value => new Intl.NumberFormat("en-US").format(value);
  const asText = value => typeof value === "string" ? value : "";

  function node(tag, className, text) {
    const result = document.createElement(tag);
    if (className) result.className = className;
    if (text !== undefined) result.textContent = String(text);
    return result;
  }

  function allowedUrl(value) {
    if (typeof value !== "string" || value.length > 4096) return null;
    try {
      const url = new URL(value);
      if (url.protocol !== "https:" || url.username || url.password || url.port) return null;
      if (url.hostname === "learn.microsoft.com") return url.href;
      if (url.hostname === "github.com" && /^\/nicholasswhite\/(?:memdocs-change-tracker|memdocs)(?:\/|$)/i.test(url.pathname)) return url.href;
    } catch (_) { /* Invalid source links are omitted. */ }
    return null;
  }

  function sourceLink(text, url, className) {
    const href = allowedUrl(url);
    if (!href) return null;
    const link = node("a", className, text);
    link.href = href;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.append(node("span", "sr-only", " (opens in a new tab)"));
    return link;
  }

  function date(value, detailed = false) {
    if (!value) return "Date unavailable";
    // A date-only value is already the observation day; midday avoids changing it across time zones.
    const parsed = new Date(/^\d{4}-\d{2}-\d{2}$/.test(value) ? value + "T12:00:00-04:00" : value);
    return Number.isNaN(parsed.getTime()) ? "Date unavailable" : (detailed ? publishedFormat : dateFormat).format(parsed);
  }

  function normalizeUpdate(update, index) {
    if (!update || typeof update !== "object") return null;
    const articles = Array.isArray(update.articles) ? update.articles.filter(article => article && typeof article === "object") : [];
    return {
      ...update,
      id: asText(update.id) || "update-" + index,
      title: asText(update.title) || "Documentation updated",
      summary: asText(update.summary),
      before: asText(update.before),
      after: asText(update.after),
      kind: Object.hasOwn(KINDS, update.kind) ? update.kind : "updated",
      platforms: Array.isArray(update.platforms) ? [...new Set(update.platforms.filter(value => typeof value === "string" && value))] : [],
      product: asText(update.product),
      area: asText(update.area),
      minor: update.minor === true || update.kind === "minor",
      observed_at: asText(update.observed_at),
      observed_date: asText(update.observed_date),
      summary_source: update.summary_source === "editorial" ? "editorial" : "automatic",
      articles,
      search: [update.title, update.summary, update.before, update.after, update.product, update.area,
        ...(Array.isArray(update.platforms) ? update.platforms : []),
        ...articles.flatMap(article => [article.title, article.path, article.previous_path])
      ].map(asText).join(" ").toLocaleLowerCase()
    };
  }

  function addOptions(select, values, labels = {}) {
    select.replaceChildren(select.options[0]);
    values.forEach(value => {
      const option = node("option", "", labels[value] || value);
      option.value = value;
      select.append(option);
    });
  }

  function setMetadata(feed) {
    const stamp = asText(feed.latest_commit_at);
    el["publication-text"].textContent = stamp ? "Latest tracked change: " + date(stamp, true) : "No tracked changes have been published yet.";
    el.publication.hidden = false;
    const history = allowedUrl(feed.history_url);
    const archive = allowedUrl(feed.archive_url);
    if (history) el["history-link"].href = history;
    if (archive) el["archive-link"].href = archive;
    el["feed-window"].replaceChildren();
    el["feed-window"].hidden = feed.truncated !== true;
    if (feed.truncated === true) {
      const total = Number.isSafeInteger(feed.total_updates) && feed.total_updates >= state.updates.length ? " of " + number(feed.total_updates) : "";
      el["feed-window"].append(document.createTextNode("This reader contains the latest " + number(state.updates.length) + total + " recorded updates. Older changes remain in the "));
      const link = sourceLink("complete history on GitHub", history || el["history-link"].href);
      if (link) el["feed-window"].append(link);
      else el["feed-window"].append(document.createTextNode("complete history on GitHub"));
      el["feed-window"].append(document.createTextNode("."));
    }
    el["baseline-note"].replaceChildren();
    if (feed.baseline && typeof feed.baseline === "object") {
      const note = asText(feed.baseline.note) || "The initial import establishes the comparison baseline. Later cards record observed changes to that baseline.";
      el["baseline-note"].append(document.createTextNode(note + " "));
      const link = sourceLink("View the initial import", feed.baseline.commit_url);
      if (link) el["baseline-note"].append(link);
      el["baseline-note"].hidden = false;
    }
  }

  function contextLabel(update) {
    const parts = [update.product, update.area].filter(Boolean);
    if (update.platforms.length) parts.push(update.platforms.join(", "));
    return parts.join(" · ");
  }

  function diffWords(before, after) {
    const tokenize = text => text.match(/\r\n|\r|\n|[^\S\r\n]+|[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]/gu) || [];
    const left = tokenize(before).map(text => ({ text, changed: true }));
    const right = tokenize(after).map(text => ({ text, changed: true }));
    let start = 0;
    let leftEnd = left.length;
    let rightEnd = right.length;
    while (start < leftEnd && start < rightEnd && left[start].text === right[start].text) {
      left[start].changed = right[start].changed = false;
      start++;
    }
    while (leftEnd > start && rightEnd > start && left[leftEnd - 1].text === right[rightEnd - 1].text) {
      left[--leftEnd].changed = right[--rightEnd].changed = false;
    }
    const m = leftEnd - start;
    const n = rightEnd - start;
    // Excerpts are bounded by the exporter. Also cap the work here for a large
    // feed entry: shared edges stay visible and the remaining span is changed.
    if (m && n && m <= 600 && n <= 600) {
      const lengths = Array.from({ length: m + 1 }, () => new Uint16Array(n + 1));
      for (let i = m - 1; i >= 0; i--) {
        for (let j = n - 1; j >= 0; j--) {
          lengths[i][j] = left[start + i].text === right[start + j].text
            ? lengths[i + 1][j + 1] + 1
            : Math.max(lengths[i + 1][j], lengths[i][j + 1]);
        }
      }
      let i = 0;
      let j = 0;
      while (i < m && j < n) {
        if (left[start + i].text === right[start + j].text) {
          left[start + i++].changed = right[start + j++].changed = false;
        } else if (lengths[i + 1][j] >= lengths[i][j + 1]) i++;
        else j++;
      }
    }
    return { before: left, after: right };
  }

  function comparisonLines(parts) {
    const lines = [[]];
    let previousCR = false;
    parts.forEach(part => {
      for (const character of part.text) {
        if (previousCR && character === "\n") {
          previousCR = false;
          continue;
        }
        previousCR = character === "\r";
        const line = lines[lines.length - 1];
        if (character === "\r" || character === "\n") {
          if (part.changed) line.push({ text: "", changed: true });
          lines.push([]);
        } else {
          const last = line[line.length - 1];
          if (last && last.changed === part.changed) last.text += character;
          else line.push({ text: character, changed: part.changed });
        }
      }
    });
    return lines;
  }

  function version(label, parts, after, emptyMessage) {
    const panel = node("section", "diff-version " + (after ? "diff-after" : "diff-before"));
    const heading = node("h4", "diff-heading", label);
    panel.append(heading);
    if (!parts.length) {
      panel.append(node("p", "diff-empty", emptyMessage));
      return panel;
    }
    const lines = node("div", "diff-lines");
    comparisonLines(parts).forEach(parts => {
      const changed = parts.some(part => part.changed);
      const row = node("div", "diff-line" + (changed ? " is-changed" : ""));
      const sign = node("span", "diff-sign", changed ? (after ? "+" : "−") : " ");
      sign.setAttribute("aria-hidden", "true");
      const text = node("pre", "diff-code");
      parts.forEach(part => text.append(part.changed
        ? node(after ? "ins" : "del", "diff-word", part.text)
        : document.createTextNode(part.text)));
      if (!parts.length) text.append(document.createTextNode("\u200b"));
      row.append(sign, text);
      lines.append(row);
    });
    panel.append(lines);
    return panel;
  }

  function renderSources(update, container) {
    if (!update.articles.length) return;
    const sourceHeading = update.kind === "media" ? (update.articles.length === 1 ? "File and source history" : "Files and source history") : (update.articles.length === 1 ? "Article and source history" : "Articles and source history");
    container.append(node("h4", "sources-heading", sourceHeading));
    const list = node("ul", "source-list");
    update.articles.forEach(article => {
      const item = node("li");
      item.append(node("p", "source-title", asText(article.title) || asText(article.path) || "Documentation article"));
      const links = node("div", "source-links");
      [
        sourceLink("Read on Microsoft Learn ↗", article.url),
        sourceLink("Previous snapshot ↗", article.old_url),
        sourceLink("Tracked snapshot ↗", article.new_url)
      ].filter(Boolean).forEach(link => links.append(link));
      item.append(links);
      if (article.previous_path && article.previous_path !== article.path) {
        item.append(node("p", "source-path", "Moved from " + asText(article.previous_path) + " to " + asText(article.path)));
      }
      list.append(item);
    });
    container.append(list);
  }

  function renderCard(update, index) {
    const article = node("article", "update");
    const titleId = "update-title-" + index;
    article.setAttribute("aria-labelledby", titleId);
    const meta = node("div", "meta");
    meta.append(node("span", "tag" + (update.kind === "new" ? " tag-new" : ""), KINDS[update.kind]));
    if (update.articles.length) {
      const noun = update.kind === "media" ? (update.articles.length === 1 ? " media file" : " media files") : (update.articles.length === 1 ? " article" : " articles");
      meta.append(node("span", "", number(update.articles.length) + noun));
    }
    const title = node("h3", "", update.title);
    title.id = titleId;
    article.append(meta, title);
    if (update.summary) article.append(node("p", "summary", update.summary));
    const context = contextLabel(update);
    if (context) article.append(node("p", "context", context));

    const details = node("details", "comparison");
    details.open = state.open.has(update.id);
    details.append(node("summary", "", update.kind === "media" ? "View the tracked media change" : "See before & after"));
    const body = node("div", "comparison-body");
    const editorial = update.summary_source === "editorial";
    body.append(node("p", "comparison-caption", editorial ? "Plain-language comparison · editorial summary of the tracked edit" : "Changed text excerpts · compare the captured documentation"));
    if (update.kind !== "media" || update.before || update.after) {
      const compare = node("div", "compare diff");
      // This exporter notice is not part of the source change. The existing
      // shortened-excerpt note below carries it outside the colored rows.
      const excerpt = text => update.excerpts_truncated
        ? text.replace(/\s*\[Excerpt shortened — open the full change for the rest\.\]$/, "")
        : text;
      const words = diffWords(excerpt(update.before), excerpt(update.after));
      compare.append(
        version("− Before", words.before, false, update.kind === "new" ? "Not previously in the tracker." : "No removed text in this excerpt."),
        version("+ After", words.after, true, update.kind === "removed" ? "No longer present in this tracked snapshot." : "No added text in this excerpt.")
      );
      body.append(compare);
    }
    if (update.excerpts_truncated) body.append(node("p", "note", "These excerpts are shortened. Open the exact change for the complete diff and surrounding context."));
    else if (!editorial && update.kind !== "media") body.append(node("p", "note", "Excerpts can retain Markdown formatting. The exact change includes surrounding context."));
    if (update.kind === "new") body.append(node("p", "note", "New to this tracker; this observation does not establish when the article or feature first became available."));
    if (update.kind === "removed") body.append(node("p", "note", "Removal from the tracked snapshot does not by itself establish that a feature was retired."));
    renderSources(update, body);
    details.append(body);
    details.addEventListener("toggle", () => details.open ? state.open.add(update.id) : state.open.delete(update.id));
    article.append(details);

    const actions = node("div", "card-actions");
    const exact = sourceLink("Exact change on GitHub ↗", update.commit_url);
    if (exact) actions.append(exact);
    const added = Number.isSafeInteger(update.lines_added) && update.lines_added >= 0 ? update.lines_added : null;
    const removed = Number.isSafeInteger(update.lines_removed) && update.lines_removed >= 0 ? update.lines_removed : null;
    if (added !== null && removed !== null && !(update.kind === "media" && added === 0 && removed === 0)) actions.append(node("span", "lines", number(added) + " lines added · " + number(removed) + " removed"));
    if (actions.childNodes.length) article.append(actions);
    return article;
  }

  function hasFilters() {
    return Boolean(el.query.value.trim() || el.product.value !== "all" || el.platform.value !== "all" || el.kind.value !== "all" || el.minor.checked);
  }

  function filterUpdates() {
    const terms = el.query.value.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
    state.filtered = state.updates.filter(update =>
      (el.minor.checked || !update.minor) &&
      (el.product.value === "all" || update.product === el.product.value) &&
      (el.platform.value === "all" || update.platforms.includes(el.platform.value)) &&
      (el.kind.value === "all" || update.kind === el.kind.value) &&
      terms.every(term => update.search.includes(term))
    );
  }

  function render(resetLimit = true) {
    if (resetLimit) state.limit = PAGE_SIZE;
    filterUpdates();
    const visible = state.filtered.slice(0, state.limit);
    const count = state.filtered.length;
    const articleCount = new Set(state.filtered.filter(update => update.kind !== "media").flatMap(update => update.articles.map(article => asText(article.path)).filter(Boolean))).size;
    el.results.textContent = number(count) + (count === 1 ? " update" : " updates") + " · " + number(articleCount) + (articleCount === 1 ? " article" : " articles");
    el.reset.hidden = !hasFilters();
    el.empty.hidden = count !== 0;
    el["empty-reset"].hidden = !hasFilters();
    el["empty-description"].textContent = state.updates.length ? (hasFilters() ? "Try a different keyword or clear your filters." : "There are no substantive updates in this published feed. Try including minor edits.") : "There are no tracked updates in the published feed yet. You can still explore the preserved archive below.";
    const fragment = document.createDocumentFragment();
    let lastDay = null;
    let group;
    visible.forEach((update, index) => {
      const day = update.observed_date || update.observed_at;
      const dayLabel = date(day);
      if (dayLabel !== lastDay) {
        group = node("section", "day");
        const heading = node("h2", "day-heading", "Observed " + dayLabel);
        heading.id = "day-" + index;
        group.setAttribute("aria-labelledby", heading.id);
        group.append(heading);
        fragment.append(group);
        lastDay = dayLabel;
      }
      group.append(renderCard(update, index));
    });
    el.feed.replaceChildren(fragment);
    el.pagination.hidden = count === 0;
    el["page-count"].textContent = "Showing " + number(visible.length) + " of " + number(count) + " matching updates";
    el["load-more"].hidden = visible.length >= count;
  }

  function reset() {
    el.query.value = "";
    el.product.value = el.platform.value = el.kind.value = "all";
    el.minor.checked = false;
    render();
    el.query.focus();
  }

  async function load() {
    if (state.loading) return;
    state.loading = true;
    el.loading.hidden = false;
    el.error.hidden = true;
    el.results.textContent = "";
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 20000);
    try {
      const response = await fetch(new URL("./feed.json", document.baseURI), { credentials: "omit", cache: "no-cache", signal: controller.signal });
      if (!response.ok) throw new Error("Feed unavailable");
      const feed = await response.json();
      if (!feed || feed.schema_version !== 1 || !Array.isArray(feed.updates)) throw new Error("Unsupported feed");
      state.updates = feed.updates.map(normalizeUpdate).filter(Boolean).sort((a, b) => (b.observed_at || b.observed_date).localeCompare(a.observed_at || a.observed_date));
      addOptions(el.product, [...new Set(state.updates.map(update => update.product).filter(Boolean))].sort());
      addOptions(el.platform, [...new Set(state.updates.flatMap(update => update.platforms))].sort());
      addOptions(el.kind, Object.keys(KINDS).filter(kind => state.updates.some(update => update.kind === kind)), KINDS);
      setMetadata(feed);
      el.filters.hidden = false;
      render();
    } catch (_) {
      el.error.hidden = false;
      el.results.textContent = "Updates could not be loaded.";
    } finally {
      window.clearTimeout(timeout);
      el.loading.hidden = true;
      state.loading = false;
    }
  }

  el.query.addEventListener("input", () => render());
  [el.product, el.platform, el.minor].forEach(control => control.addEventListener("change", () => {
    if (control === el.minor && !el.minor.checked && el.kind.value === "minor") el.kind.value = "all";
    render();
  }));
  el.kind.addEventListener("change", () => {
    if (el.kind.value === "minor") el.minor.checked = true;
    render();
  });
  el.reset.addEventListener("click", reset);
  el["empty-reset"].addEventListener("click", reset);
  el["load-more"].addEventListener("click", () => {
    const firstNewIndex = Math.min(state.limit, state.filtered.length);
    state.limit += PAGE_SIZE;
    render(false);
    el.results.textContent += " · " + number(Math.min(state.limit, state.filtered.length)) + " now shown";
    const firstNewTitle = document.getElementById("update-title-" + firstNewIndex);
    if (firstNewTitle) {
      firstNewTitle.tabIndex = -1;
      firstNewTitle.focus();
    }
  });
  el.retry.addEventListener("click", load);
  load();
})();
