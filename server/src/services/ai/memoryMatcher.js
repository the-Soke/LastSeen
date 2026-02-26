// server/src/services/ai/memoryMatcher.js
// ─────────────────────────────────────────────────────────────────────────────
//  Memory-Based Description Matcher
//
//  Converts unstructured witness recall ("tall boy, red hoodie, near the market")
//  into structured feature tokens, then scores them against active case data.
//
//  Algorithm layers (in order of application):
//    1. Tokenise + stem (Porter stemmer via `natural`)
//    2. Field-specific extraction (age, gender, clothing, colour, location)
//    3. Per-field fuzzy matching using Jaro-Winkler similarity
//    4. Weighted field scores → composite match score (0–100)
//    5. Audit trail: which fields matched and at what confidence
//
//  Install:
//    npm install natural
// ─────────────────────────────────────────────────────────────────────────────

const natural = require('natural');

const stemmer    = natural.PorterStemmer;
const tokenizer  = new natural.WordTokenizer();
const jaroWinkler = natural.JaroWinklerDistance;

// ─────────────────────────────────────────────────────────────────────────────
//  Field weights (must sum to 1.0)
//  Clothing is weighted highest because it's the most specific & actionable
//  data a witness can provide without being trained observers.
// ─────────────────────────────────────────────────────────────────────────────
const FIELD_WEIGHTS = {
  gender:   0.15,
  age:      0.15,
  clothing: 0.35,   // highest — most specific witness detail
  skinTone: 0.10,
  hair:     0.15,
  location: 0.10,
};

// ─────────────────────────────────────────────────────────────────────────────
//  Vocabulary maps for structured field extraction
// ─────────────────────────────────────────────────────────────────────────────

const GENDER_TERMS = {
  male:    ['boy', 'male', 'man', 'he', 'him', 'son', 'lad', 'guy', 'brother'],
  female:  ['girl', 'female', 'woman', 'she', 'her', 'daughter', 'lady', 'lass'],
};

const SKIN_TONE_TERMS = {
  very_light: ['very light', 'pale', 'fair', 'albino'],
  light:      ['light', 'light-skinned', 'light skin'],
  medium:     ['medium', 'brown', 'caramel', 'olive', 'tan', 'tanned'],
  dark:       ['dark', 'dark-skinned', 'dark skin', 'darker'],
  very_dark:  ['very dark', 'deep dark', 'black skin'],
};

const COLOUR_TERMS = [
  'red', 'blue', 'green', 'yellow', 'orange', 'purple', 'pink', 'black',
  'white', 'grey', 'gray', 'brown', 'navy', 'maroon', 'gold', 'silver',
  'beige', 'khaki', 'turquoise', 'cream', 'light blue', 'dark blue',
];

const CLOTHING_TERMS = [
  'shirt', 'tshirt', 't-shirt', 'blouse', 'top', 'jersey', 'vest',
  'trouser', 'trousers', 'pant', 'pants', 'jeans', 'shorts', 'skirt', 'dress',
  'hoodie', 'jacket', 'coat', 'sweater', 'jumper', 'cardigan',
  'shoe', 'shoes', 'boot', 'boots', 'sandal', 'sandals', 'sneaker',
  'cap', 'hat', 'school', 'uniform', 'bag', 'backpack',
];

const HAIR_TERMS = [
  'short', 'long', 'medium', 'bald', 'shaved',
  'black', 'brown', 'blonde', 'grey', 'red', 'dyed',
  'braided', 'braid', 'cornrow', 'cornrows', 'afro', 'dreadlock', 'dreadlocks',
  'curly', 'wavy', 'straight', 'natural', 'relaxed', 'weave', 'loc', 'locs',
  'tied', 'ponytail', 'plaited',
];

// ─────────────────────────────────────────────────────────────────────────────
//  Main API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Score a witness description against a single case's known details.
 *
 * @param {string} witnessDescription   Free-text witness recall
 * @param {CaseProfile} caseProfile     Structured data from missing_persons row
 * @returns {MemoryMatchResult}
 */
function scoreDescriptionAgainstCase(witnessDescription, caseProfile) {
  const parsed   = parseDescription(witnessDescription);
  const fields   = matchFields(parsed, caseProfile);
  const composite = computeCompositeScore(fields);

  return {
    matchScore:        Math.round(composite),        // 0–100
    parsedFeatures:    parsed,
    fieldScores:       fields,
    matchedFields:     buildMatchedFieldsAudit(fields),
    requiresHumanReview: true,                       // always
    modelVersion:      'keyword-jaro-winkler-v1',
    computedAt:        new Date().toISOString(),
  };
}

/**
 * Score a description against multiple active cases, returning ranked results.
 *
 * @param {string}        witnessDescription
 * @param {CaseProfile[]} activeCases
 * @returns {RankedMatch[]}
 */
function rankCasesFromDescription(witnessDescription, activeCases) {
  return activeCases
    .map(c => ({
      caseId:     c.caseId,
      caseNumber: c.caseNumber,
      ...scoreDescriptionAgainstCase(witnessDescription, c),
    }))
    .sort((a, b) => b.matchScore - a.matchScore);
}

// ─────────────────────────────────────────────────────────────────────────────
//  Step 1: Parse the witness description into structured feature tokens
// ─────────────────────────────────────────────────────────────────────────────

function parseDescription(text) {
  const lower = text.toLowerCase().trim();

  return {
    gender:      extractGender(lower),
    age:         extractAge(lower),
    clothing:    extractClothing(lower),
    colours:     extractColours(lower),
    skinTone:    extractSkinTone(lower),
    hair:        extractHair(lower),
    location:    extractLocation(lower),
    rawTokens:   stemTokens(lower),
  };
}

function stemTokens(text) {
  return tokenizer.tokenize(text).map(t => stemmer.stem(t));
}

function extractGender(text) {
  for (const [gender, terms] of Object.entries(GENDER_TERMS)) {
    if (terms.some(t => text.includes(t))) return gender;
  }
  return null;
}

function extractAge(text) {
  // Matches: "8 years old", "8yo", "8-year-old", "around 8", "age 8"
  const patterns = [
    /\b(\d{1,2})\s*(?:years?\s*old|yo|yrs?)\b/i,
    /\bage[d]?\s*(\d{1,2})\b/i,
    /\baround\s+(\d{1,2})\b/i,
    /\babout\s+(\d{1,2})\b/i,
  ];
  for (const pattern of patterns) {
    const m = text.match(pattern);
    if (m) return parseInt(m[1], 10);
  }
  return null;
}

function extractColours(text) {
  return COLOUR_TERMS.filter(c => text.includes(c));
}

function extractClothing(text) {
  const found = [];
  for (const item of CLOTHING_TERMS) {
    if (text.includes(item)) {
      // Try to pair the clothing item with adjacent colours
      const colourMatch = findAdjacentColour(text, item);
      found.push({ item, colour: colourMatch });
    }
  }
  return found;
}

function findAdjacentColour(text, clothingItem) {
  // Look for colour within 3 words of the clothing item
  const words = text.split(/\s+/);
  const idx   = words.findIndex(w => w.includes(clothingItem.split(' ')[0]));
  if (idx === -1) return null;
  const window = words.slice(Math.max(0, idx - 3), idx + 2).join(' ');
  return COLOUR_TERMS.find(c => window.includes(c)) || null;
}

function extractSkinTone(text) {
  for (const [tone, terms] of Object.entries(SKIN_TONE_TERMS)) {
    if (terms.some(t => text.includes(t))) return tone;
  }
  return null;
}

function extractHair(text) {
  const found = HAIR_TERMS.filter(t => text.includes(t));
  return found.length ? found : null;
}

function extractLocation(text) {
  // Extract quoted places, words after "near", "at", "by", "around"
  const matches = [];
  const locationPattern = /\b(?:near|at|by|around|outside|behind|in front of)\s+(?:the\s+)?([a-z][a-z\s]{1,30}?)(?:\s*[,.]|$)/gi;
  let m;
  while ((m = locationPattern.exec(text)) !== null) {
    matches.push(m[1].trim());
  }
  return matches.length ? matches : null;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Step 2: Score each parsed field against the case profile
// ─────────────────────────────────────────────────────────────────────────────

function matchFields(parsed, caseProfile) {
  return {
    gender:   matchGender(parsed.gender, caseProfile.gender),
    age:      matchAge(parsed.age, caseProfile.ageAtReport),
    clothing: matchClothing(parsed, caseProfile.clothingDesc),
    skinTone: matchSkinTone(parsed.skinTone, caseProfile.skinTone),
    hair:     matchHair(parsed.hair, caseProfile.hairColor, caseProfile.hairStyle),
    location: matchLocation(parsed.location, caseProfile.lastSeenPlace),
  };
}

function matchGender(parsed, caseGender) {
  if (!parsed || !caseGender || caseGender === 'unknown') {
    return { score: 0, confidence: 'absent' };
  }
  const score = parsed === caseGender ? 1.0 : 0.0;
  return { score, confidence: score === 1 ? 'exact' : 'mismatch' };
}

function matchAge(parsedAge, caseAge) {
  if (parsedAge === null || !caseAge) return { score: 0, confidence: 'absent' };

  const diff = Math.abs(parsedAge - caseAge);
  if (diff === 0) return { score: 1.0,  confidence: 'exact',   parsedAge };
  if (diff <= 1)  return { score: 0.8,  confidence: 'close',   parsedAge };
  if (diff <= 2)  return { score: 0.5,  confidence: 'possible',parsedAge };
  if (diff <= 4)  return { score: 0.2,  confidence: 'weak',    parsedAge };
  return               { score: 0.0,  confidence: 'mismatch', parsedAge };
}

function matchClothing(parsed, clothingDesc) {
  if (!clothingDesc || !parsed.clothing.length) {
    return { score: 0, confidence: 'absent', matches: [] };
  }

  const descLower   = clothingDesc.toLowerCase();
  const matches     = [];
  let totalScore    = 0;

  for (const { item, colour } of parsed.clothing) {
    // Jaro-Winkler similarity against each word in the clothing description
    const descWords = tokenizer.tokenize(descLower);
    const bestItemScore = Math.max(
      ...descWords.map(w => jaroWinkler(item, w, { ignoreCase: true }))
    );

    let fieldScore = bestItemScore;

    // Bonus: if the colour also matches
    if (colour && descLower.includes(colour)) {
      fieldScore = Math.min(1, fieldScore + 0.2);
      matches.push({ item, colour, score: fieldScore, colourConfirmed: true });
    } else {
      matches.push({ item, colour, score: fieldScore, colourConfirmed: false });
    }

    totalScore += fieldScore;
  }

  const avgScore = totalScore / parsed.clothing.length;
  return {
    score:      parseFloat(avgScore.toFixed(4)),
    confidence: avgScore >= 0.8 ? 'strong' : avgScore >= 0.5 ? 'partial' : 'weak',
    matches,
  };
}

function matchSkinTone(parsedTone, caseTone) {
  if (!parsedTone || !caseTone) return { score: 0, confidence: 'absent' };

  const tones    = ['very_light','light','medium','dark','very_dark'];
  const parsedIdx = tones.indexOf(parsedTone);
  const caseIdx   = tones.indexOf(caseTone);

  if (parsedIdx === -1 || caseIdx === -1) return { score: 0, confidence: 'unknown' };

  const diff = Math.abs(parsedIdx - caseIdx);
  const score = diff === 0 ? 1.0 : diff === 1 ? 0.6 : 0.0;
  return {
    score,
    confidence: diff === 0 ? 'exact' : diff === 1 ? 'adjacent' : 'mismatch',
  };
}

function matchHair(parsedHair, caseHairColor, caseHairStyle) {
  if (!parsedHair?.length || (!caseHairColor && !caseHairStyle)) {
    return { score: 0, confidence: 'absent' };
  }

  const caseHairText = [caseHairColor, caseHairStyle]
    .filter(Boolean).join(' ').toLowerCase();

  let totalScore = 0;
  for (const term of parsedHair) {
    const termScore = Math.max(
      ...tokenizer.tokenize(caseHairText).map(w =>
        jaroWinkler(stemmer.stem(term), stemmer.stem(w), { ignoreCase: true })
      )
    );
    totalScore += termScore;
  }

  const avgScore = parsedHair.length ? totalScore / parsedHair.length : 0;
  return {
    score:      parseFloat(avgScore.toFixed(4)),
    confidence: avgScore >= 0.8 ? 'strong' : avgScore >= 0.5 ? 'partial' : 'weak',
    matchedTerms: parsedHair,
  };
}

function matchLocation(parsedLocations, caseLastSeenPlace) {
  if (!parsedLocations?.length || !caseLastSeenPlace) {
    return { score: 0, confidence: 'absent' };
  }

  const placeLower = caseLastSeenPlace.toLowerCase();
  let bestScore = 0;

  for (const loc of parsedLocations) {
    const score = jaroWinkler(loc.toLowerCase(), placeLower, { ignoreCase: true });
    bestScore = Math.max(bestScore, score);
  }

  return {
    score:      parseFloat(bestScore.toFixed(4)),
    confidence: bestScore >= 0.8 ? 'strong' : bestScore >= 0.5 ? 'partial' : 'weak',
  };
}

// ─────────────────────────────────────────────────────────────────────────────
//  Step 3: Weighted composite score
// ─────────────────────────────────────────────────────────────────────────────

function computeCompositeScore(fields) {
  let weightedSum    = 0;
  let totalWeight    = 0;
  let activeFields   = 0;

  for (const [field, weight] of Object.entries(FIELD_WEIGHTS)) {
    const f = fields[field];
    if (!f || f.confidence === 'absent') continue; // skip missing data

    weightedSum  += f.score * weight;
    totalWeight  += weight;
    activeFields++;
  }

  if (activeFields === 0) return 0;

  // Normalise by the weight of available fields (don't penalise for missing data)
  const normalised = totalWeight > 0 ? (weightedSum / totalWeight) : 0;

  // Scale to 0–100 and apply a confidence penalty when <3 fields matched
  const confidencePenalty = activeFields < 3 ? 0.75 : 1.0;
  return Math.min(100, normalised * 100 * confidencePenalty);
}

function buildMatchedFieldsAudit(fields) {
  // Returns the JSON blob stored in ai_memory_matches.matched_fields
  const audit = {};
  for (const [field, data] of Object.entries(fields)) {
    if (data.confidence !== 'absent') {
      audit[field] = {
        score:      data.score,
        confidence: data.confidence,
        ...(data.matches    ? { matches: data.matches }         : {}),
        ...(data.parsedAge  ? { parsedAge: data.parsedAge }     : {}),
        ...(data.matchedTerms ? { matchedTerms: data.matchedTerms } : {}),
      };
    }
  }
  return audit;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Score → label (mirrors facialSimilarity.scoreToLabel for consistent UI)
// ─────────────────────────────────────────────────────────────────────────────

function scoreToLabel(score) {
  if (score >= 75) return { label: 'Strong Description Match', tier: 'strong',   color: 'amber'  };
  if (score >= 50) return { label: 'Possible Match',           tier: 'possible', color: 'yellow' };
  if (score >= 30) return { label: 'Partial Match',            tier: 'partial',  color: 'slate'  };
  return             { label: 'Low Match',                 tier: 'low',      color: 'gray'   };
}

module.exports = {
  scoreDescriptionAgainstCase,
  rankCasesFromDescription,
  parseDescription,
  scoreToLabel,
  FIELD_WEIGHTS,
};
