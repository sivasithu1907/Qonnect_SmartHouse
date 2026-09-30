// Source-backed values supplied by the owner for Umm Garn — PIN 70153699.
// Nothing here is an approval, commitment, payment, delivery or completion.

export const SOURCE_DASHBOARD = 'Source dashboard (owner-supplied)';
export const SOURCE_MASTER_SHEET = 'Master Sheet (owner-supplied)';
export const SOURCE_MATERIAL_TRACKER = 'Material supply tracker (owner-supplied)';

export const PROJECTS = [
  {
    code: 'PIN 70153699',
    name: 'Umm Garn',
    location: 'Umm Garn',
    status: 'Existing project — budget needs confirmation',
    description: 'Existing project. Budget and material supply seeded from owner-supplied source values only.',
    seedSource: true,
  },
  {
    code: 'PIN 70153016',
    name: 'Umm Garn',
    location: 'Umm Garn',
    status: 'New project — setup',
    description: 'New project. Clean workspace with standard structure only (no prices, dates or records).',
    seedSource: false,
  },
] as const;

export const FIXED_COSTS: Array<{ name: string; amount: number }> = [
  { name: 'Contractor Cost', amount: 509500.0 },
  { name: 'Consultant Cost', amount: 28000.0 },
  { name: 'Kahramaa Cost', amount: 35000.0 },
];
// Fixed cost subtotal shown in the source: 572,500.00 (kept as a source reference)

export const CATEGORY_ESTIMATES: Array<{ name: string; a: number | null; b: number | null }> = [
  { name: 'Window', a: 34796.5, b: 32175.0 },
  { name: 'Door', a: 49980.0, b: 40700.0 },
  { name: 'Floor', a: 129030.2, b: 35611.0 },
  { name: 'False Ceiling', a: 27008.4, b: 47000.0 },
  { name: 'Wall Marble / Bathroom', a: 12308.4, b: 10940.8 },
  { name: 'Bathroom Accessories', a: 32000.0, b: 19500.0 },
  { name: 'Plumbing', a: 58400.0, b: 48000.0 },
  { name: 'Staircase', a: 16552.0, b: 16556.0 },
  { name: 'Air Conditioning', a: 49531.0, b: 60000.0 },
  { name: 'Electrical & ELV', a: 80000.0, b: 80000.0 },
  { name: 'Paint Work (Approx.)', a: 50000.0, b: 70000.0 },
  { name: 'External Kitchen', a: 13060.0, b: 10000.0 },
  { name: 'Majlis Bathroom - Marble', a: 4920.0, b: 2624.0 },
  { name: 'Landscape', a: 10000.0, b: null },
  { name: 'Insulation', a: 26000.0, b: null },
  { name: 'Foam / Cladding', a: 35000.0, b: null },
];

export const SUMMARY_REFERENCES: Array<{ label: string; a: number | null; b: number | null; note: string }> = [
  { label: 'Finishing subtotal', a: 628586.5, b: 473106.8, note: '' },
  { label: 'Installation 15%', a: null, b: 172673.2, note: 'Shown under Variant B only; calculation basis needs review.' },
  { label: 'Misc 10%', a: 62858.65, b: null, note: 'Shown under Variant A only.' },
  { label: 'Subtotal', a: 691445.15, b: 645780.0, note: '' },
  { label: 'Subtotal with exclusions', a: 534055.5, b: 645780.0, note: '' },
  { label: 'Fixed costs', a: 572500.0, b: 572500.0, note: 'Contractor 509,500.00 + Consultant 28,000.00 + Kahramaa 35,000.00.' },
  {
    label: 'Grand total shown',
    a: 1798000.65,
    b: 1864060.0,
    note: 'Appears to combine subtotal rows in a way that may double-count costs. Not an approved budget. Do not recalculate or approve without an explicit owner decision.',
  },
];

type Resp = 'owner' | 'contractor' | 'needs_confirmation';
export interface SourceMaterial {
  category: string;
  items: string[];
  responsibility: Resp;
  responsibilityNote?: string;
  requiredOnSite?: string; // YYYY-MM-DD, only where the source gives it
  deliveryDateNote?: string;
  isPackage?: boolean;
  ownerSupply?: string;
  contractorScope?: string;
}

export const MATERIALS: SourceMaterial[] = [
  {
    category: 'Tiles, Ceramic & Marble',
    items: ['Ceramic tiles', 'Porcelain tiles', 'Marble', 'Granite'],
    responsibility: 'owner',
    requiredOnSite: '2026-10-10',
    ownerSupply: 'Owner supplies ceramic, porcelain, marble, and granite for floors and walls.',
    contractorScope: 'Contractor supplies cement mortar, cement/sand, approved adhesive mortar, anti-bacterial grout, floor protection/covering, and installation labor.',
  },
  {
    category: 'Electrical Works & Lighting',
    items: ['Lighting fixtures', 'Spotlights'],
    responsibility: 'owner',
    ownerSupply: 'Owner supplies lighting fixtures and spotlights.',
    contractorScope: 'Contractor supplies and installs cables/wires, switches/sockets (MK), PVC conduits, distribution boards (Schneider/Eaton), and other installation work.',
  },
  {
    category: 'Low Current Systems & Cameras',
    items: ['CCTV cameras', 'Intercom screens', 'Network switches', 'Routers'],
    responsibility: 'owner',
    ownerSupply: 'Owner supplies CCTV camera devices, intercom screens, switches, and routers.',
    contractorScope: 'Contractor scope includes English 25 mm PVC conduit extension, internet manholes, and rough-in for 8 CCTV camera points.',
  },
  {
    category: 'Water Supply & Equipment',
    items: ['Rotomolded water tanks', 'Grundfos water pumps'],
    responsibility: 'owner',
    ownerSupply: 'Owner supplies rotomolded water tanks and Grundfos pumps.',
    contractorScope: 'Contractor supplies/installs German PPR pipes, pipe insulation, valves, and installation consumables.',
  },
  {
    category: 'Sanitary Sets & Fixtures',
    items: ['Toilets', 'Washbasins', 'Bathtubs', 'Shower sets', 'Mixers', 'Water heaters', 'Floor drain covers', 'Shower drains'],
    responsibility: 'owner',
    ownerSupply: 'Owner supplies sanitary sets, toilets, washbasins, bathtub/shower, mixers, water heaters, floor drain covers, and shower drains (bathrooms & kitchens).',
    contractorScope: 'Contractor handles rough-in, installation, network connection, consumables, fittings, and operational/pressure testing at no extra cost to the owner.',
  },
  {
    category: 'Drainage & Rainwater',
    items: ['Drainage manhole covers'],
    responsibility: 'owner',
    ownerSupply: 'Owner supplies drainage and rainwater manhole covers.',
    contractorScope: 'Contractor supplies/installs UPVC pipes and gasket fittings, drainage manholes, rainwater network, soak-away pits, and AC condensate network.',
  },
  { category: 'Windows & Doors', items: ['Windows', 'Doors'], responsibility: 'needs_confirmation' },
  {
    category: 'Gypsum Board & False Ceiling',
    items: ['Gypsum boards', 'Ceiling framing and accessories'],
    responsibility: 'needs_confirmation',
    deliveryDateNote: 'Contractor confirmation required',
  },
  { category: 'Painting Works', items: ['Primer', 'Wall putty', 'Interior paint', 'Exterior paint'], responsibility: 'needs_confirmation' },
  { category: 'Staircase Works', items: ['Staircase finishing materials', 'Handrails and balustrades'], responsibility: 'needs_confirmation' },
  { category: 'Air Conditioning', items: ['Air-conditioning units', 'Copper pipes and insulation'], responsibility: 'needs_confirmation' },
  { category: 'External Kitchen', items: ['Kitchen cabinets', 'Kitchen countertops', 'Kitchen sink and mixer'], responsibility: 'needs_confirmation' },
  { category: 'Landscape Works', items: ['Plants and grass', 'Irrigation pipes and accessories'], responsibility: 'needs_confirmation' },
  { category: 'Foam / Dry Cladding', items: ['Foam / dry cladding panels'], responsibility: 'needs_confirmation' },
  {
    category: 'Insulation Works (Roof & Bathrooms)',
    items: ['Insulation works package (roof & bathrooms)'],
    responsibility: 'contractor',
    responsibilityNote: 'Source: owner supply not required; contractor scope.',
    isPackage: true,
    ownerSupply: 'Owner supply not required.',
    contractorScope: 'Contractor scope includes bitumen, 4 mm membrane, 5 cm polystyrene, nylon, foam, screed concrete, plastering, and fillets.',
  },
];
