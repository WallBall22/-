const { normalizeArabic } = require('./arabic');

const RAW = [
  // Arabic function words
  'في', 'من', 'على', 'الى', 'عن', 'مع', 'هذا', 'هذه', 'ذلك', 'تلك',
  'التي', 'الذي', 'هو', 'هي', 'ان', 'او', 'ثم', 'كل', 'ما', 'لا',
  // English function words
  'the', 'a', 'an', 'of', 'and', 'or', 'to', 'in', 'on', 'for', 'is', 'are',
  'was', 'were', 'be', 'with', 'by', 'at', 'as', 'it', 'this', 'that',
];

const STOPWORDS = new Set(RAW.map(normalizeArabic));

module.exports = { STOPWORDS };
