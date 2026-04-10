"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.dedupeByHeight = dedupeByHeight;
exports.sortByHeightDesc = sortByHeightDesc;
exports.mergePaginatedBlocks = mergePaginatedBlocks;
function dedupeByHeight(items) {
    const seen = new Set();
    return items.filter((item) => {
        if (seen.has(item.height)) {
            return false;
        }
        seen.add(item.height);
        return true;
    });
}
function sortByHeightDesc(items) {
    return [...items].sort((a, b) => b.height - a.height);
}
function mergePaginatedBlocks(existing, incoming) {
    return dedupeByHeight([...existing, ...incoming]);
}
