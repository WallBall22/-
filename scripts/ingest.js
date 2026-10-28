const { ingestFolder } = require('../src/knowledge/ingest');

ingestFolder('documents', 'data/index.json')
  .then(({ documents, chunks, emptyPages }) => {
    console.log(`Ingested ${documents} document(s), ${chunks} chunk(s), ${emptyPages.length} empty page(s).`);
  })
  .catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
