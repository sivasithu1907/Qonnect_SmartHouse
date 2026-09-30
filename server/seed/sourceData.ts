// Owner-supplied structure for Umm Garn — PIN 70153699 (used only for fresh installs).
// No budget amounts are seeded; nothing here is an approval, commitment, payment, delivery or completion.

export const SOURCE_MATERIAL_TRACKER = 'Material supply tracker (owner-supplied)';

export const PROJECTS = [
  {
    code: 'PIN 70153699',
    name: 'Umm Garn',
    location: 'Umm Garn',
    status: 'Existing project — budget needs confirmation',
    description: 'Existing project. Budget categories and material supply lines seeded from owner-supplied sources; approved amounts need confirmation.',
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
