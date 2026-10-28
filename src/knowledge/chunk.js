const CHUNK_SIZE = 500;
const CHUNK_OVERLAP = 80;

function chunkPages(docName, pages) {
	const chunks = [];
	const step = CHUNK_SIZE - CHUNK_OVERLAP;
	for (const { page, text } of pages) {
		const trimmed = String(text || '').trim();
		if (!trimmed) continue;
		let index = 0;
		for (let start = 0; ; start += step) {
			chunks.push({
				id: `${docName}#p${page}#${index++}`,
				docName,
				page,
				text: trimmed.slice(start, start + CHUNK_SIZE),
			});
			if (start + CHUNK_SIZE >= trimmed.length) break;
		}
	}
	return chunks;
}

module.exports = { chunkPages };
