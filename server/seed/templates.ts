// Standard, project-neutral templates. They contain names and dependencies only —
// never prices, quantities, dates, people, suppliers or statuses.

export const FIXED_COST_ITEMS = ['Contractor Cost', 'Consultant Cost', 'Kahramaa Cost'] as const;

export const FINISHING_CATEGORIES = [
  'Window',
  'Door',
  'Floor',
  'False Ceiling',
  'Wall Marble / Bathroom',
  'Bathroom Accessories',
  'Plumbing',
  'Staircase',
  'Air Conditioning',
  'Electrical & ELV',
  'Paint Work (Approx.)',
  'External Kitchen',
  'Majlis Bathroom - Marble',
  'Landscape',
  'Insulation',
  'Foam / Cladding',
] as const;

export interface TemplateTask {
  key: string;
  name: string;
  holdPoint?: boolean;
  dependsOn?: string[];
}
export interface TemplatePhase {
  name: string;
  description: string;
  tasks: TemplateTask[];
}

/** 20-phase planning template from setup to handover. Dependencies reference task keys. */
export const TIMELINE_TEMPLATE: TemplatePhase[] = [
  {
    name: 'Project setup, scope review, budget confirmation, and contractor/consultant responsibilities',
    description: 'Confirm scope, control budget, contract responsibilities and reporting lines.',
    tasks: [
      { key: 'p01-scope', name: 'Review project scope and contract documents' },
      { key: 'p01-budget', name: 'Confirm control budget and approved amounts', dependsOn: ['p01-scope'] },
      { key: 'p01-resp', name: 'Confirm contractor / consultant / owner supply responsibilities', dependsOn: ['p01-scope'] },
    ],
  },
  {
    name: 'Design coordination, measurements, drawings, specifications, quotations, and approvals',
    description: 'Coordinate drawings and specifications; obtain quotations and approvals.',
    tasks: [
      { key: 'p02-drawings', name: 'Coordinate drawings and specifications', dependsOn: ['p01-resp'] },
      { key: 'p02-quotes', name: 'Collect quotations for owner-supply materials', dependsOn: ['p02-drawings'] },
      { key: 'p02-approvals', name: 'Obtain material / drawing approvals', holdPoint: true, dependsOn: ['p02-quotes'] },
    ],
  },
  {
    name: 'Permits and authority/utility coordination as applicable to the approved project documents',
    description: 'Only the permits and utility steps required by the approved project documents.',
    tasks: [
      { key: 'p03-permits', name: 'Confirm required permits / authority approvals', dependsOn: ['p02-drawings'] },
      { key: 'p03-utility', name: 'Coordinate utility applications (e.g. Kahramaa) as applicable', dependsOn: ['p03-permits'] },
    ],
  },
  {
    name: 'Site survey, mobilization, access, storage, safety, and site preparation',
    description: 'Site handover to contractor, access, storage and safety set-up.',
    tasks: [
      { key: 'p04-survey', name: 'Site survey and handover to contractor', dependsOn: ['p03-permits'] },
      { key: 'p04-mobilize', name: 'Mobilization, storage, access and safety set-up', dependsOn: ['p04-survey'] },
    ],
  },
  {
    name: 'Groundworks, foundations, substructure, and underground services',
    description: 'Excavation, foundations, substructure and buried services.',
    tasks: [
      { key: 'p05-found', name: 'Excavation and foundations', dependsOn: ['p04-mobilize'] },
      { key: 'p05-ugs', name: 'Underground drainage and services', dependsOn: ['p05-found'] },
      { key: 'p05-insp', name: 'Inspect underground services before backfilling', holdPoint: true, dependsOn: ['p05-ugs'] },
    ],
  },
  {
    name: 'Structural frame, slabs, blockwork, roof, and building envelope',
    description: 'Frame, slabs, blockwork and roof structure.',
    tasks: [
      { key: 'p06-frame', name: 'Structural frame and slabs', dependsOn: ['p05-insp'] },
      { key: 'p06-block', name: 'Blockwork', dependsOn: ['p06-frame'] },
      { key: 'p06-roof', name: 'Roof slab and envelope', dependsOn: ['p06-frame'] },
    ],
  },
  {
    name: 'Waterproofing and insulation, with required inspection and water/flood tests before covering',
    description: 'Roof and wet-area waterproofing and insulation, tested before being covered.',
    tasks: [
      { key: 'p07-wp', name: 'Roof and bathroom waterproofing and insulation', dependsOn: ['p06-roof'] },
      { key: 'p07-test', name: 'Water / flood test and inspection before covering', holdPoint: true, dependsOn: ['p07-wp'] },
    ],
  },
  {
    name: 'MEP first-fix: electrical conduits, plumbing, drainage, AC routes, and low-current conduits/cabling',
    description: 'All concealed services installed before walls and ceilings are closed.',
    tasks: [
      { key: 'p08-elec', name: 'Electrical conduits and first-fix', dependsOn: ['p06-block'] },
      { key: 'p08-plumb', name: 'Plumbing and drainage first-fix', dependsOn: ['p06-block'] },
      { key: 'p08-ac', name: 'AC routes, copper pipes and condensate', dependsOn: ['p06-block'] },
      { key: 'p08-elv', name: 'Low-current conduits / cabling (CCTV, intercom, network)', dependsOn: ['p06-block'] },
    ],
  },
  {
    name: 'MEP inspections and testing before closing walls or ceilings',
    description: 'Hold point: first-fix inspected and tested before plastering or ceiling closure.',
    tasks: [
      { key: 'p09-insp', name: 'MEP first-fix inspection and pressure / continuity tests', holdPoint: true, dependsOn: ['p08-elec', 'p08-plumb', 'p08-ac', 'p08-elv'] },
    ],
  },
  {
    name: 'Plastering, wall preparation, screed, and substrate readiness',
    description: 'Plaster, screed and substrate preparation after MEP inspection.',
    tasks: [
      { key: 'p10-plaster', name: 'Plastering and wall preparation', dependsOn: ['p09-insp'] },
      { key: 'p10-screed', name: 'Screed and substrate readiness', dependsOn: ['p09-insp', 'p07-test'] },
    ],
  },
  {
    name: 'Windows, doors, external sealing, and weather-tightness checks',
    description: 'Frames, glazing and sealing; confirm weather-tightness.',
    tasks: [
      { key: 'p11-win', name: 'Install windows and external doors', dependsOn: ['p10-plaster'] },
      { key: 'p11-seal', name: 'External sealing and weather-tightness check', holdPoint: true, dependsOn: ['p11-win'] },
    ],
  },
  {
    name: 'Floor/wall tiles, marble, granite, and other floor finishes',
    description: 'Tiling after waterproofing tests pass and substrate is ready.',
    tasks: [
      { key: 'p12-tiles', name: 'Floor and wall tiling / marble / granite', dependsOn: ['p10-screed', 'p07-test'] },
    ],
  },
  {
    name: 'Gypsum/false ceiling framing, above-ceiling inspection, boards, and access panels',
    description: 'Ceiling services inspected before boards close the ceiling.',
    tasks: [
      { key: 'p13-frame', name: 'Ceiling framing', dependsOn: ['p09-insp'] },
      { key: 'p13-insp', name: 'Above-ceiling services inspection', holdPoint: true, dependsOn: ['p13-frame'] },
      { key: 'p13-boards', name: 'Gypsum boards and access panels', dependsOn: ['p13-insp'] },
    ],
  },
  {
    name: 'Painting and wall finishes',
    description: 'Primer, putty and paint once surfaces are ready.',
    tasks: [
      { key: 'p14-paint', name: 'Primer, putty and painting', dependsOn: ['p10-plaster', 'p13-boards'] },
    ],
  },
  {
    name: 'Electrical/ELV fixtures, lighting, switches, sockets, cameras, intercom, and network equipment',
    description: 'Second-fix electrical and low-current devices after finishes.',
    tasks: [
      { key: 'p15-elec', name: 'Lighting, switches and sockets', dependsOn: ['p14-paint'] },
      { key: 'p15-elv', name: 'CCTV cameras, intercom and network equipment', dependsOn: ['p14-paint'] },
    ],
  },
  {
    name: 'Plumbing and sanitary fixtures, water tanks/pumps, connections, and pressure/operational tests',
    description: 'Sanitary fixtures, tanks and pumps; operational testing.',
    tasks: [
      { key: 'p16-fix', name: 'Sanitary fixtures, mixers and water heaters', dependsOn: ['p12-tiles', 'p14-paint'] },
      { key: 'p16-tanks', name: 'Water tanks and pumps connection', dependsOn: ['p09-insp'] },
      { key: 'p16-test', name: 'Pressure and operational tests', holdPoint: true, dependsOn: ['p16-fix', 'p16-tanks'] },
    ],
  },
  {
    name: 'Air-conditioning equipment, final connections, controls, and commissioning',
    description: 'AC units installed, connected and commissioned.',
    tasks: [
      { key: 'p17-units', name: 'Install AC units and final connections', dependsOn: ['p14-paint'] },
      { key: 'p17-comm', name: 'AC commissioning', holdPoint: true, dependsOn: ['p17-units'] },
    ],
  },
  {
    name: 'Doors, joinery, kitchen cabinets/countertops, and equipment',
    description: 'Internal doors, joinery and kitchen installation.',
    tasks: [
      { key: 'p18-doors', name: 'Internal doors and joinery', dependsOn: ['p14-paint'] },
      { key: 'p18-kitchen', name: 'Kitchen cabinets, countertops, sink and mixer', dependsOn: ['p12-tiles', 'p14-paint'] },
    ],
  },
  {
    name: 'Staircase, handrails, external works, landscape, and irrigation',
    description: 'Staircase finishing, handrails, external works and landscaping.',
    tasks: [
      { key: 'p19-stair', name: 'Staircase finishing, handrails and balustrades', dependsOn: ['p12-tiles'] },
      { key: 'p19-land', name: 'External works, landscape and irrigation', dependsOn: ['p11-seal'] },
    ],
  },
  {
    name: 'Integrated testing, defects/snags, rectification, final consultant inspection, document handover, and owner acceptance',
    description: 'Commissioning follows installation; snag, rectify, inspect and hand over.',
    tasks: [
      { key: 'p20-test', name: 'Integrated systems testing', dependsOn: ['p15-elec', 'p15-elv', 'p16-test', 'p17-comm'] },
      { key: 'p20-snag', name: 'Snag list and rectification', dependsOn: ['p20-test', 'p18-doors', 'p18-kitchen', 'p19-stair', 'p19-land'] },
      { key: 'p20-final', name: 'Final consultant inspection', holdPoint: true, dependsOn: ['p20-snag'] },
      { key: 'p20-handover', name: 'Document handover and owner acceptance', dependsOn: ['p20-final'] },
    ],
  },
];
