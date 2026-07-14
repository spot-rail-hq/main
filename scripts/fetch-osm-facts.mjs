#!/usr/bin/env node
/**
 * scripts/fetch-osm-facts.mjs
 * ─────────────────────────────────────────────────────────────────────────
 * Populates the STRUCTURED/PHYSICAL fields in stations-content.json and
 * routes-content.json from live OpenStreetMap data (via a self-hosted
 * Overpass instance — see the OVERPASS_URL comment below for why) —
 * deterministic, no AI involved. Run manually/periodically:
 *
 *   node scripts/fetch-osm-facts.mjs
 *
 * Edit the JOBS array below to add/remove entries each time you run it —
 * there is no live production dependency on this script or on Overpass;
 * it only ever writes static JSON that the app reads at request time.
 *
 * ─── FIELD OWNERSHIP (read this before editing another script) ───────────
 * This script is the ONLY writer for:
 *   stations-content.json  →  platforms, wheelchair, operators
 *   routes-content.json    →  length_km, stopping_stations, type, operator
 * It never writes: name, wikipedia_title, synopsis, opened_year,
 * operating_since, notable_features, photo, location, listed_status,
 * franchises, parent_company, or any other field — those belong to
 * scripts/fetch-wikipedia-facts.mjs (narrative/historical) or to manual
 * curation. See that script's header for its own owned-fields list, and
 * stations-content.json/routes-content.json's own "_notes" for the full
 * split. Existence/open-closed status is owned by the separate, pre-
 * existing NaPTAN re-import pipeline — not touched here either.
 *
 * Each run does a shallow merge: only the fields this script owns are
 * ever assigned on an existing entry; every other field already present
 * (curated or written by the Wikipedia script) is left untouched. This is
 * what makes it safe to run both scripts in either order, repeatedly.
 * ───────────────────────────────────────────────────────────────────────
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const STATIONS_PATH = path.join(ROOT, 'stations-content.json');
const ROUTES_PATH = path.join(ROOT, 'routes-content.json');
const STATION_LIST_PATH = path.join(ROOT, 'station-list.json');

// OSM PTv2 route relations almost always list "stop" members as bare
// public_transport=stop_position nodes on the track (name tag only) — the
// actual railway=station node carrying ref:crs is a separate OSM object
// nearby, not the relation member itself (confirmed against the real
// Cross-City Line relation: 0/22 stop members had ref:crs, all 22 had a
// clean name). So CRS resolution matches the stop's name against the
// app's own station-list.json (already the trusted full station list —
// see coordsForCrs() in map.html for the client-side equivalent) rather
// than assuming ref:crs is present on the relation member.
function normalizeStationName(name) {
  return (name || '')
    .toLowerCase()
    .replace(/\(.*?\)/g, '')
    .replace(/\brail(?:way)? station\b/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}
const stationList = loadJson(STATION_LIST_PATH);
const nameToCrs = new Map(stationList.map((s) => [normalizeStationName(s.name), s.crs]));

// ─── Jobs to run this pass — edit this, then `node scripts/fetch-osm-facts.mjs` ──
// station jobs: just a CRS code — looked up via OSM's ref:crs tag (exact match).
// route jobs: either a known OSM relation id (fast, unambiguous — find it once
// on osm.org/relation/<id> or overpass-turbo.eu and paste it here), or a
// name + bbox to search for (bbox keeps the public Overpass server from
// timing out on an unscoped whole-planet regex search, and narrows false
// matches). `slug` is this route's key in routes-content.json.
// Full re-enrichment, membership-checking method (2026-07-13): all
// 2,637 station-list.json CRS codes, re-run end to end (not just the
// previously-unpopulated ones) since every station's operators array
// needs re-deriving under the new method, not just the gaps. Routes left
// empty — unrelated to this pass.
const JOBS = {
  stations: ["AAP", "AAT", "ABA", "ABC", "ABD", "ABE", "ABH", "ABW", "ABX", "ABY", "ACB", "ACC", "ACG", "ACH", "ACK", "ACL", "ACN", "ACR", "ACT", "ACY", "ADC", "ADD", "ADK", "ADL", "ADM", "ADN", "ADR", "ADS", "ADV", "ADW", "AFK", "AFS", "AFV", "AGL", "AGR", "AGS", "AGT", "AGV", "AHD", "AHN", "AHS", "AHT", "AHV", "AIG", "AIN", "AIR", "ALB", "ALD", "ALF", "ALK", "ALM", "ALN", "ALO", "ALP", "ALR", "ALT", "ALV", "ALW", "ALX", "AMB", "AMF", "AML", "AMR", "AMT", "AMY", "ANC", "AND", "ANF", "ANG", "ANL", "ANN", "ANS", "ANZ", "AON", "APB", "APD", "APF", "APG", "APN", "APP", "APS", "APY", "ARB", "ARD", "ARG", "ARL", "ARM", "ARN", "ARR", "ART", "ARU", "ASB", "ASC", "ASD", "ASF", "ASG", "ASH", "ASK", "ASL", "ASN", "ASP", "ASS", "AST", "ASY", "ATB", "ATH", "ATL", "ATN", "ATT", "AUD", "AUG", "AUI", "AUK", "AUR", "AUW", "AVF", "AVM", "AVN", "AVP", "AVY", "AWK", "AWM", "AWT", "AXM", "AXP", "AYH", "AYL", "AYP", "AYR", "AYS", "AYW", "BAA", "BAB", "BAC", "BAD", "BAG", "BAH", "BAI", "BAJ", "BAK", "BAL", "BAM", "BAN", "BAR", "BAS", "BAT", "BAU", "BAV", "BAW", "BAY", "BBG", "BBK", "BBL", "BBN", "BBS", "BBW", "BCB", "BCC", "BCE", "BCF", "BCG", "BCH", "BCJ", "BCK", "BCN", "BCS", "BCU", "BCV", "BCY", "BCZ", "BDA", "BDB", "BDG", "BDH", "BDI", "BDK", "BDL", "BDM", "BDN", "BDQ", "BDS", "BDT", "BDW", "BDY", "BEA", "BEB", "BEC", "BEE", "BEF", "BEG", "BEH", "BEJ", "BEL", "BEM", "BEN", "BEP", "BER", "BES", "BET", "BEU", "BEV", "BEX", "BEY", "BFD", "BFE", "BFF", "BFN", "BFR", "BGA", "BGD", "BGE", "BGG", "BGH", "BGI", "BGL", "BGM", "BGN", "BGS", "BGV", "BHC", "BHD", "BHG", "BHI", "BHK", "BHM", "BHO", "BHR", "BHS", "BIA", "BIB", "BIC", "BID", "BIF", "BIG", "BIK", "BIL", "BIN", "BIO", "BIP", "BIS", "BIT", "BIW", "BIY", "BKA", "BKC", "BKD", "BKG", "BKH", "BKJ", "BKL", "BKM", "BKN", "BKO", "BKP", "BKQ", "BKR", "BKS", "BKT", "BKW", "BLA", "BLB", "BLD", "BLE", "BLG", "BLH", "BLI", "BLK", "BLL", "BLM", "BLN", "BLO", "BLP", "BLT", "BLV", "BLW", "BLX", "BLY", "BMB", "BMC", "BMD", "BME", "BMF", "BMG", "BMH", "BML", "BMN", "BMO", "BMP", "BMR", "BMS", "BMT", "BMV", "BMY", "BNA", "BNC", "BND", "BNE", "BNF", "BNG", "BNH", "BNI", "BNL", "BNM", "BNP", "BNR", "BNS", "BNT", "BNV", "BNW", "BNY", "BOA", "BOC", "BOD", "BOE", "BOG", "BOH", "BOM", "BON", "BOP", "BOR", "BOT", "BOW", "BPA", "BPB", "BPC", "BPK", "BPN", "BPS", "BPT", "BPW", "BRA", "BRC", "BRE", "BRF", "BRG", "BRH", "BRI", "BRK", "BRL", "BRM", "BRN", "BRO", "BRP", "BRR", "BRS", "BRT", "BRU", "BRV", "BRW", "BRX", "BRY", "BSB", "BSC", "BSD", "BSE", "BSH", "BSI", "BSJ", "BSK", "BSL", "BSM", "BSN", "BSO", "BSP", "BSR", "BSS", "BSU", "BSV", "BSW", "BSY", "BTB", "BTD", "BTE", "BTF", "BTG", "BTH", "BTL", "BTN", "BTO", "BTP", "BTR", "BTS", "BTT", "BTY", "BUB", "BUC", "BUD", "BUE", "BUG", "BUH", "BUI", "BUJ", "BUK", "BUL", "BUO", "BUS", "BUT", "BUU", "BUW", "BUX", "BUY", "BVD", "BWB", "BWD", "BWG", "BWK", "BWN", "BWO", "BWS", "BWT", "BXB", "BXD", "BXH", "BXW", "BXY", "BYA", "BYB", "BYC", "BYD", "BYE", "BYF", "BYI", "BYK", "BYL", "BYM", "BYN", "BYS", "CAA", "CAC", "CAD", "CAG", "CAK", "CAM", "CAN", "CAO", "CAR", "CAS", "CAT", "CAU", "CAY", "CBB", "CBC", "CBD", "CBE", "CBG", "CBH", "CBK", "CBL", "CBN", "CBP", "CBR", "CBS", "CBW", "CBX", "CBY", "CCC", "CCH", "CCT", "CDB", "CDD", "CDF", "CDI", "CDN", "CDO", "CDQ", "CDR", "CDS", "CDT", "CDU", "CDY", "CEA", "CED", "CEF", "CEH", "CEL", "CES", "CET", "CEY", "CFB", "CFC", "CFD", "CFF", "CFH", "CFL", "CFN", "CFO", "CFR", "CFT", "CGD", "CGM", "CGN", "CGW", "CHC", "CHD", "CHE", "CHF", "CHG", "CHH", "CHI", "CHK", "CHL", "CHM", "CHN", "CHO", "CHP", "CHR", "CHT", "CHU", "CHW", "CHX", "CHY", "CIL", "CIM", "CIR", "CIT", "CKH", "CKL", "CKN", "CKS", "CKT", "CKY", "CLA", "CLC", "CLD", "CLE", "CLG", "CLH", "CLI", "CLJ", "CLK", "CLL", "CLM", "CLN", "CLP", "CLR", "CLS", "CLT", "CLU", "CLV", "CLW", "CLY", "CMB", "CMD", "CME", "CMF", "CMH", "CML", "CMN", "CMO", "CMR", "CMS", "CMY", "CNE", "CNF", "CNG", "CNL", "CNM", "CNN", "CNO", "CNP", "CNR", "CNS", "CNW", "CNY", "COA", "COB", "COE", "COH", "COI", "COL", "COM", "CON", "COO", "COP", "COR", "COS", "COT", "COV", "COW", "COY", "CPA", "CPH", "CPK", "CPM", "CPN", "CPT", "CPU", "CPW", "CPY", "CRA", "CRB", "CRD", "CRE", "CRF", "CRG", "CRH", "CRI", "CRK", "CRL", "CRM", "CRN", "CRO", "CRR", "CRS", "CRT", "CRV", "CRW", "CRY", "CSA", "CSB", "CSD", "CSG", "CSH", "CSK", "CSL", "CSM", "CSN", "CSO", "CSR", "CSS", "CST", "CSW", "CSY", "CTE", "CTF", "CTH", "CTK", "CTL", "CTM", "CTN", "CTO", "CTR", "CTT", "CTW", "CUA", "CUB", "CUD", "CUF", "CUH", "CUM", "CUP", "CUS", "CUW", "CUX", "CWB", "CWC", "CWD", "CWE", "CWH", "CWL", "CWM", "CWN", "CWS", "CWU", "CWX", "CYB", "CYK", "CYN", "CYP", "CYS", "CYT", "DAG", "DAK", "DAL", "DAM", "DAN", "DAR", "DAS", "DAT", "DBC", "DBD", "DBE", "DBG", "DBL", "DBR", "DBY", "DCG", "DCH", "DCT", "DCW", "DDG", "DDK", "DDP", "DEA", "DEE", "DEN", "DEP", "DEW", "DFD", "DFE", "DFI", "DFL", "DFR", "DGC", "DGL", "DGT", "DGY", "DHM", "DHN", "DID", "DIG", "DIN", "DIS", "DKD", "DKG", "DKT", "DLG", "DLH", "DLJ", "DLK", "DLM", "DLR", "DLS", "DLT", "DLW", "DLY", "DMC", "DMF", "DMG", "DMH", "DMK", "DMP", "DMR", "DMS", "DMY", "DND", "DNG", "DNL", "DNM", "DNO", "DNS", "DNT", "DNY", "DOC", "DOD", "DOL", "DON", "DOR", "DOT", "DOW", "DPD", "DPT", "DRF", "DRG", "DRI", "DRM", "DRN", "DRO", "DRT", "DRU", "DSL", "DSM", "DST", "DSY", "DTG", "DTN", "DTW", "DUD", "DUL", "DUM", "DUN", "DUR", "DVC", "DVH", "DVN", "DVP", "DVY", "DWD", "DWL", "DWN", "DWW", "DYC", "DYF", "DYP", "DZY", "EAD", "EAG", "EAL", "EAR", "EBA", "EBB", "EBD", "EBK", "EBL", "EBN", "EBR", "EBT", "EBV", "ECC", "ECL", "ECP", "ECR", "ECS", "EDB", "EDG", "EDL", "EDN", "EDP", "EDR", "EDW", "EDY", "EFF", "EFL", "EGF", "EGG", "EGH", "EGN", "EGR", "EGT", "EGY", "EKB", "EKL", "ELD", "ELE", "ELG", "ELO", "ELP", "ELR", "ELS", "ELT", "ELW", "ELY", "EMD", "EML", "EMP", "EMS", "ENC", "ENF", "ENL", "ENT", "EPD", "EPH", "EPS", "ERA", "ERD", "ERH", "ERI", "ERL", "ESD", "ESH", "ESL", "ESM", "EST", "ESW", "ETC", "ETL", "EUS", "EVE", "EWD", "EWE", "EWR", "EWW", "EXC", "EXD", "EXG", "EXM", "EXN", "EXR", "EXT", "EYN", "FAL", "FAV", "FAZ", "FBY", "FCN", "FDX", "FEA", "FEL", "FEN", "FER", "FFA", "FFD", "FGH", "FGT", "FGW", "FIL", "FIN", "FIT", "FKC", "FKG", "FKK", "FKW", "FLD", "FLE", "FLF", "FLI", "FLM", "FLN", "FLT", "FLW", "FLX", "FML", "FMR", "FMT", "FNB", "FNC", "FNH", "FNN", "FNR", "FNT", "FNV", "FNW", "FNY", "FOC", "FOD", "FOG", "FOH", "FOK", "FOR", "FOX", "FPK", "FRB", "FRD", "FRE", "FRF", "FRI", "FRL", "FRM", "FRN", "FRO", "FRR", "FRS", "FRT", "FRW", "FRY", "FSB", "FSG", "FSK", "FST", "FTM", "FTN", "FTW", "FWY", "FXN", "FYS", "FZH", "FZP", "FZW", "GAL", "GAR", "GBD", "GBG", "GBK", "GBL", "GBS", "GCH", "GCL", "GCR", "GCT", "GCW", "GDH", "GDL", "GDN", "GDP", "GEA", "GER", "GFD", "GFF", "GFN", "GGJ", "GGV", "GIG", "GIL", "GIP", "GIR", "GKC", "GKW", "GLC", "GLD", "GLE", "GLF", "GLG", "GLH", "GLM", "GLO", "GLQ", "GLS", "GLT", "GLY", "GLZ", "GMB", "GMD", "GMG", "GMN", "GMT", "GMV", "GMY", "GNB", "GNF", "GNH", "GNL", "GNR", "GNT", "GNW", "GOB", "GOD", "GOE", "GOF", "GOL", "GOM", "GOO", "GOR", "GOS", "GOX", "GPK", "GPO", "GQL", "GRA", "GRB", "GRC", "GRF", "GRH", "GRK", "GRL", "GRN", "GRP", "GRS", "GRT", "GRV", "GRY", "GSC", "GSD", "GSL", "GSN", "GST", "GSW", "GSY", "GTA", "GTH", "GTN", "GTO", "GTR", "GTW", "GTY", "GUI", "GUN", "GVE", "GVH", "GWE", "GWN", "GYM", "GYP", "HAB", "HAC", "HAD", "HAF", "HAG", "HAI", "HAL", "HAM", "HAN", "HAP", "HAS", "HAT", "HAV", "HAY", "HAZ", "HBB", "HBD", "HBL", "HBN", "HBP", "HBY", "HCB", "HCH", "HCN", "HCT", "HDB", "HDE", "HDF", "HDG", "HDH", "HDL", "HDM", "HDN", "HDW", "HDY", "HEC", "HED", "HEI", "HEL", "HEN", "HER", "HES", "HEV", "HEW", "HEX", "HFD", "HFE", "HFN", "HFS", "HFX", "HGD", "HGF", "HGG", "HGM", "HGN", "HGR", "HGS", "HGT", "HGY", "HHB", "HHD", "HHE", "HHL", "HHY", "HIA", "HIB", "HID", "HIG", "HII", "HIL", "HIN", "HIP", "HIR", "HIT", "HKC", "HKH", "HKM", "HKN", "HKW", "HLB", "HLC", "HLD", "HLE", "HLF", "HLG", "HLI", "HLL", "HLM", "HLN", "HLR", "HLS", "HLU", "HLW", "HLY", "HMC", "HMD", "HME", "HML", "HMM", "HMN", "HMP", "HMS", "HMT", "HMW", "HMY", "HNA", "HNB", "HNC", "HND", "HNF", "HNG", "HNH", "HNK", "HNL", "HNT", "HNW", "HNX", "HOC", "HOH", "HOK", "HOL", "HON", "HOO", "HOP", "HOR", "HOT", "HOU", "HOV", "HOW", "HOX", "HOY", "HOZ", "HPA", "HPD", "HPE", "HPL", "HPN", "HPQ", "HPT", "HRD", "HRE", "HRH", "HRL", "HRM", "HRN", "HRO", "HRR", "HRS", "HRW", "HRY", "HSB", "HSC", "HSD", "HSG", "HSK", "HSL", "HST", "HSW", "HSY", "HTC", "HTE", "HTF", "HTH", "HTN", "HTO", "HTW", "HTY", "HUB", "HUD", "HUL", "HUN", "HUP", "HUR", "HUT", "HUY", "HVF", "HVN", "HWB", "HWC", "HWD", "HWH", "HWI", "HWM", "HWN", "HWV", "HWW", "HWY", "HXM", "HYB", "HYC", "HYD", "HYH", "HYK", "HYL", "HYM", "HYN", "HYR", "HYS", "HYT", "HYW", "IBM", "IFD", "IFI", "IGD", "ILK", "ILN", "IMW", "INC", "INE", "ING", "INH", "INK", "INP", "INR", "INS", "INT", "INV", "IPS", "IRL", "IRV", "ISL", "ISP", "IVA", "IVR", "IVY", "JCH", "JEQ", "JHN", "JOH", "JOR", "KBC", "KBF", "KBK", "KBN", "KBW", "KBX", "KCK", "KDB", "KDG", "KDY", "KEH", "KEI", "KEL", "KEM", "KEN", "KET", "KEY", "KGE", "KGH", "KGL", "KGM", "KGN", "KGP", "KGS", "KGT", "KGX", "KID", "KIH", "KIL", "KIN", "KIR", "KIT", "KIV", "KKB", "KKD", "KKH", "KKM", "KKN", "KKS", "KLD", "KLF", "KLM", "KLN", "KLY", "KMH", "KMK", "KML", "KMP", "KMS", "KNA", "KND", "KNE", "KNF", "KNG", "KNI", "KNL", "KNN", "KNO", "KNR", "KNS", "KNT", "KNU", "KNW", "KPA", "KPT", "KRK", "KSL", "KSN", "KSW", "KTH", "KTL", "KTN", "KTR", "KTW", "KVD", "KVP", "KWB", "KWD", "KWG", "KWL", "KWN", "KYL", "KYN", "LAC", "LAD", "LAG", "LAI", "LAK", "LAM", "LAN", "LAP", "LAR", "LAS", "LAU", "LAW", "LAY", "LBG", "LBK", "LBO", "LBR", "LBT", "LBZ", "LCC", "LCG", "LCK", "LCL", "LCN", "LCS", "LDN", "LDS", "LDY", "LEA", "LEB", "LED", "LEE", "LEG", "LEH", "LEI", "LEL", "LEM", "LEN", "LEO", "LER", "LES", "LET", "LEU", "LEV", "LEW", "LEY", "LFD", "LGB", "LGD", "LGE", "LGF", "LGG", "LGJ", "LGK", "LGM", "LGN", "LGO", "LGS", "LGW", "LHA", "LHD", "LHE", "LHM", "LHO", "LHR", "LHS", "LHW", "LIC", "LID", "LIF", "LIH", "LIN", "LIP", "LIS", "LIT", "LIV", "LKE", "LLA", "LLC", "LLD", "LLE", "LLF", "LLG", "LLH", "LLI", "LLJ", "LLL", "LLM", "LLN", "LLO", "LLR", "LLS", "LLT", "LLV", "LLW", "LLY", "LMR", "LMS", "LNB", "LND", "LNG", "LNK", "LNR", "LNW", "LNY", "LNZ", "LOB", "LOC", "LOF", "LOH", "LOO", "LOS", "LOT", "LOW", "LPG", "LPR", "LPT", "LPW", "LPY", "LRB", "LRD", "LRG", "LRH", "LSK", "LSN", "LST", "LSW", "LSX", "LSY", "LTG", "LTH", "LTK", "LTL", "LTM", "LTN", "LTP", "LTS", "LTT", "LTV", "LUD", "LUT", "LUX", "LVC", "LVG", "LVJ", "LVL", "LVM", "LVN", "LVT", "LWH", "LWM", "LWR", "LWS", "LWT", "LYC", "LYD", "LYE", "LYM", "LYP", "LYT", "LZB", "MAC", "MAG", "MAI", "MAL", "MAN", "MAO", "MAR", "MAS", "MAT", "MAU", "MAX", "MAY", "MBK", "MBR", "MBT", "MCB", "MCE", "MCH", "MCM", "MCN", "MCO", "MCV", "MDB", "MDE", "MDG", "MDL", "MDN", "MDS", "MDW", "MEC", "MEL", "MEN", "MEO", "MEP", "MER", "MES", "MEV", "MEW", "MEX", "MEY", "MFA", "MFD", "MFF", "MFH", "MFL", "MFT", "MGM", "MGN", "MHM", "MHR", "MHS", "MIA", "MIC", "MIH", "MIJ", "MIK", "MIL", "MIM", "MIN", "MIR", "MIS", "MKC", "MKM", "MKR", "MKT", "MLB", "MLD", "MLF", "MLG", "MLH", "MLM", "MLN", "MLT", "MLW", "MLY", "MMO", "MNC", "MNE", "MNG", "MNN", "MNP", "MNR", "MNS", "MOB", "MOG", "MON", "MOO", "MOR", "MOS", "MOT", "MOV", "MPK", "MPL", "MPT", "MRB", "MRD", "MRF", "MRN", "MRP", "MRR", "MRS", "MRT", "MRW", "MRY", "MSD", "MSH", "MSK", "MSL", "MSN", "MSO", "MSR", "MSS", "MST", "MSW", "MTA", "MTB", "MTC", "MTG", "MTH", "MTL", "MTM", "MTN", "MTO", "MTP", "MTS", "MTV", "MUB", "MUF", "MUI", "MVL", "MYB", "MYH", "MYL", "MYT", "MZH", "NAN", "NAR", "NAY", "NBA", "NBC", "NBE", "NBN", "NBR", "NBT", "NBW", "NBY", "NCE", "NCK", "NCL", "NCM", "NCO", "NCT", "NDL", "NEG", "NEH", "NEI", "NEL", "NEM", "NES", "NET", "NEW", "NFA", "NFD", "NFL", "NFN", "NGT", "NHD", "NHE", "NHL", "NIT", "NLN", "NLR", "NLS", "NLT", "NLW", "NMC", "NMK", "NMN", "NMP", "NMT", "NNG", "NNP", "NNT", "NOA", "NOP", "NOR", "NOT", "NPD", "NQU", "NQY", "NRB", "NRC", "NRD", "NRN", "NRT", "NRW", "NSB", "NSD", "NSG", "NSH", "NTA", "NTB", "NTC", "NTH", "NTL", "NTN", "NTR", "NUF", "NUM", "NUN", "NUT", "NVH", "NVN", "NVR", "NWA", "NWB", "NWD", "NWE", "NWH", "NWI", "NWM", "NWN", "NWP", "NWR", "NWT", "NWX", "NXG", "OBN", "OCK", "OHL", "OKE", "OKL", "OKM", "OKN", "OLD", "OLF", "OLT", "OLY", "OMS", "OPK", "OPY", "ORE", "ORN", "ORP", "ORR", "OTF", "OUN", "OUS", "OUT", "OVE", "OVR", "OXF", "OXN", "OXS", "OXT", "PAD", "PAL", "PAN", "PAR", "PAT", "PBL", "PBO", "PBR", "PBY", "PCD", "PCN", "PDG", "PDW", "PDX", "PEA", "PEB", "PEG", "PEM", "PEN", "PER", "PES", "PET", "PEV", "PEW", "PFL", "PFM", "PFR", "PFY", "PGM", "PGN", "PHG", "PHR", "PIL", "PIN", "PIR", "PIT", "PKG", "PKS", "PKT", "PLC", "PLD", "PLE", "PLG", "PLK", "PLM", "PLN", "PLS", "PLT", "PLU", "PLW", "PLY", "PMA", "PMB", "PMD", "PMG", "PMH", "PMP", "PMR", "PMS", "PMT", "PMW", "PNA", "PNE", "PNF", "PNL", "PNM", "PNR", "PNS", "PNW", "PNY", "PNZ", "POK", "POL", "PON", "POO", "POP", "POR", "POT", "PPD", "PPK", "PPL", "PRA", "PRB", "PRE", "PRH", "PRI", "PRL", "PRN", "PRP", "PRR", "PRS", "PRT", "PRU", "PRW", "PRY", "PSC", "PSE", "PSH", "PSL", "PSN", "PST", "PSW", "PTA", "PTB", "PTC", "PTD", "PTF", "PTG", "PTH", "PTK", "PTL", "PTM", "PTR", "PTT", "PTW", "PUL", "PUO", "PUR", "PUT", "PWE", "PWL", "PWW", "PWY", "PYC", "PYE", "PYG", "PYJ", "PYL", "PYN", "PYP", "PYT", "QBR", "QPK", "QPW", "QRB", "QRP", "QUI", "QYD", "RAD", "RAI", "RAM", "RAN", "RAU", "RAV", "RAY", "RBR", "RBS", "RCA", "RCC", "RCD", "RCE", "RDA", "RDB", "RDC", "RDD", "RDF", "RDG", "RDH", "RDM", "RDN", "RDR", "RDS", "RDT", "RDW", "REC", "RED", "REE", "REI", "REL", "RET", "RFD", "RFY", "RGL", "RGP", "RGT", "RGW", "RHD", "RHI", "RHL", "RHM", "RHO", "RHY", "RIA", "RIC", "RID", "RIL", "RIS", "RKT", "RLG", "RLN", "RMB", "RMC", "RMD", "RMF", "RML", "RNF", "RNH", "RNM", "RNR", "ROB", "ROC", "ROE", "ROG", "ROL", "ROM", "ROO", "ROR", "ROS", "ROW", "RRB", "RRN", "RSG", "RSH", "RSN", "RTN", "RTR", "RUA", "RUE", "RUF", "RUG", "RUN", "RUS", "RUT", "RVB", "RVN", "RWC", "RYB", "RYD", "RYE", "RYH", "RYN", "RYP", "RYR", "RYS", "SAA", "SAB", "SAC", "SAD", "SAE", "SAF", "SAH", "SAJ", "SAL", "SAM", "SAN", "SAR", "SAS", "SAT", "SAU", "SAV", "SAW", "SAX", "SAY", "SBE", "SBF", "SBJ", "SBK", "SBM", "SBP", "SBR", "SBS", "SBT", "SBU", "SBV", "SBY", "SCA", "SCF", "SCG", "SCH", "SCR", "SCS", "SCT", "SCU", "SCY", "SDA", "SDB", "SDC", "SDE", "SDF", "SDG", "SDH", "SDL", "SDM", "SDN", "SDP", "SDR", "SDW", "SDY", "SEA", "SEB", "SEC", "SED", "SEE", "SEF", "SEG", "SEH", "SEJ", "SEL", "SEM", "SEN", "SER", "SES", "SET", "SEV", "SFA", "SFD", "SFI", "SFL", "SFN", "SFO", "SFR", "SGB", "SGL", "SGM", "SGN", "SGR", "SHB", "SHC", "SHD", "SHE", "SHF", "SHH", "SHI", "SHJ", "SHL", "SHM", "SHN", "SHO", "SHP", "SHR", "SHS", "SHT", "SHU", "SHV", "SHW", "SHY", "SIA", "SIC", "SID", "SIE", "SIH", "SIL", "SIN", "SIP", "SIT", "SIV", "SJP", "SJS", "SKE", "SKG", "SKI", "SKM", "SKN", "SKS", "SKW", "SLA", "SLB", "SLD", "SLH", "SLK", "SLL", "SLO", "SLQ", "SLR", "SLS", "SLT", "SLV", "SLW", "SLY", "SMA", "SMB", "SMC", "SMD", "SMG", "SMH", "SMK", "SML", "SMN", "SMO", "SMR", "SMT", "SMY", "SNA", "SND", "SNE", "SNF", "SNG", "SNH", "SNI", "SNK", "SNL", "SNN", "SNO", "SNP", "SNR", "SNS", "SNT", "SNW", "SNY", "SOA", "SOB", "SOC", "SOE", "SOF", "SOG", "SOH", "SOI", "SOJ", "SOK", "SOL", "SOM", "SON", "SOO", "SOP", "SOR", "SOT", "SOU", "SOV", "SOW", "SPA", "SPB", "SPF", "SPH", "SPI", "SPK", "SPL", "SPN", "SPO", "SPP", "SPR", "SPS", "SPT", "SPU", "SPY", "SQE", "SQH", "SQU", "SRA", "SRC", "SRD", "SRG", "SRH", "SRI", "SRL", "SRN", "SRO", "SRR", "SRS", "SRT", "SRU", "SRY", "SSC", "SSD", "SSE", "SSM", "SSS", "SST", "STA", "STC", "STD", "STE", "STF", "STG", "STH", "STJ", "STK", "STL", "STM", "STN", "STO", "STP", "STQ", "STR", "STS", "STT", "STU", "STV", "STW", "STY", "STZ", "SUC", "SUD", "SUG", "SUM", "SUN", "SUO", "SUP", "SUR", "SUT", "SUU", "SUY", "SVB", "SVG", "SVK", "SVL", "SVR", "SVS", "SWA", "SWD", "SWE", "SWG", "SWI", "SWK", "SWL", "SWM", "SWN", "SWO", "SWR", "SWS", "SWT", "SWY", "SXY", "SYA", "SYB", "SYD", "SYH", "SYL", "SYS", "SYT", "TAB", "TAC", "TAD", "TAF", "TAH", "TAI", "TAL", "TAM", "TAP", "TAT", "TAU", "TAY", "TBD", "TBW", "TBY", "TCR", "TDU", "TEA", "TED", "TEN", "TEO", "TEY", "TFC", "TGM", "TGS", "THA", "THB", "THC", "THD", "THE", "THH", "THI", "THL", "THO", "THP", "THS", "THT", "THU", "THW", "TIL", "TIP", "TIR", "TIS", "TLB", "TLC", "TLH", "TLK", "TLS", "TMC", "TNA", "TNF", "TNN", "TNP", "TNS", "TOD", "TOK", "TOL", "TOM", "TON", "TOO", "TOP", "TOT", "TPB", "TPC", "TPN", "TQY", "TRA", "TRB", "TRD", "TRE", "TRF", "TRH", "TRI", "TRM", "TRN", "TRO", "TRR", "TRS", "TRU", "TRY", "TTF", "TTH", "TTN", "TUH", "TUL", "TUR", "TUT", "TVP", "TWB", "TWI", "TWN", "TWY", "TYB", "TYC", "TYG", "TYL", "TYS", "TYW", "UCK", "UDD", "UHA", "UHL", "ULC", "ULL", "ULV", "UMB", "UNI", "UPH", "UPL", "UPM", "UPT", "UPW", "URM", "UTT", "UTY", "UWL", "VAL", "VIC", "VIR", "VXH", "WAC", "WAD", "WAE", "WAF", "WAL", "WAM", "WAN", "WAO", "WAR", "WAS", "WAT", "WAV", "WAW", "WBC", "WBD", "WBL", "WBO", "WBP", "WBQ", "WBR", "WBY", "WCB", "WCF", "WCH", "WCK", "WCL", "WCM", "WCP", "WCR", "WCX", "WCY", "WDB", "WDD", "WDE", "WDH", "WDL", "WDM", "WDN", "WDO", "WDS", "WDT", "WDU", "WEA", "WED", "WEE", "WEH", "WEL", "WEM", "WES", "WET", "WEY", "WFF", "WFH", "WFI", "WFJ", "WFL", "WFN", "WGA", "WGC", "WGN", "WGR", "WGT", "WGV", "WGW", "WHA", "WHC", "WHD", "WHE", "WHG", "WHI", "WHL", "WHM", "WHN", "WHP", "WHR", "WHS", "WHT", "WHX", "WHY", "WIA", "WIC", "WID", "WIH", "WIJ", "WIL", "WIM", "WIN", "WIV", "WKB", "WKD", "WKF", "WKG", "WKI", "WKK", "WKM", "WLC", "WLD", "WLE", "WLF", "WLG", "WLH", "WLI", "WLM", "WLN", "WLO", "WLP", "WLS", "WLT", "WLV", "WLW", "WLY", "WMA", "WMB", "WMC", "WMD", "WME", "WMG", "WMI", "WML", "WMN", "WMR", "WMS", "WMW", "WNC", "WND", "WNE", "WNF", "WNG", "WNH", "WNL", "WNM", "WNN", "WNP", "WNR", "WNS", "WNT", "WNW", "WNY", "WOB", "WOF", "WOH", "WOK", "WOL", "WOM", "WON", "WOO", "WOP", "WOR", "WOS", "WPE", "WPL", "WRB", "WRE", "WRH", "WRK", "WRL", "WRM", "WRN", "WRP", "WRS", "WRT", "WRU", "WRW", "WRX", "WRY", "WSA", "WSB", "WSE", "WSF", "WSH", "WSL", "WSM", "WSR", "WST", "WSU", "WSW", "WTA", "WTB", "WTC", "WTE", "WTG", "WTH", "WTI", "WTL", "WTM", "WTN", "WTO", "WTR", "WTS", "WTT", "WTY", "WVF", "WVH", "WWA", "WWC", "WWD", "WWI", "WWL", "WWO", "WWR", "WWW", "WXC", "WYB", "WYE", "WYL", "WYM", "WYT", "YAE", "YAL", "YAT", "YEO", "YET", "YNW", "YOK", "YRD", "YRK", "YRM", "YRT", "YSM", "YSR", "YVJ", "YVP", "ZBU", "ZCW", "ZFD", "ZWL", "ZZT"],
  routes: [],
};

// 2026-07-13: switched from the public overpass-api.de instance to a
// self-hosted one (wiktorn/overpass-api Docker image, GB extract from
// Geofabrik) — the public instance rate-limited hard enough during a
// 100-station validation batch (117× 429, 162× 504) that a full ~2,637-
// station run extrapolated to ~37 hours even after fixing the incremental-
// save bug below. The local instance answers the same queries in well
// under a second with zero rate-limiting, since it's not a shared resource
// anymore. Override with OVERPASS_URL if you need to point back at a public
// instance for a one-off check.
const OVERPASS_URL = process.env.OVERPASS_URL || 'http://localhost:12345/api/interpreter';
// Still identifies the client even though it's talking to our own instance
// now — cheap to keep, costs nothing, and means this doesn't need editing
// again if OVERPASS_URL is ever pointed back at a public instance.
const USER_AGENT = 'SpotRailHQ-content-script/1.0 (+https://srhq.uk; static JSON build step, not a live API dependency)';

async function overpassQuery(ql, { retries = 3 } = {}) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    const res = await fetch(OVERPASS_URL, {
      method: 'POST',
      headers: { 'User-Agent': USER_AGENT, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'data=' + encodeURIComponent(ql),
    });
    if (res.ok) return res.json();
    // 429/504 backoff is now sized for a local instance recovering from a
    // transient hiccup (e.g. briefly overloaded during a big query), not for
    // sharing a public server fairly — was 5s/10s/15s, that made sense when
    // every retry was also politeness toward other Overpass users.
    if ((res.status === 429 || res.status === 504) && attempt < retries) {
      const waitMs = attempt * 500;
      console.warn(`  Overpass ${res.status}, retrying in ${waitMs}ms (attempt ${attempt}/${retries})…`);
      await new Promise((r) => setTimeout(r, waitMs));
      continue;
    }
    const body = await res.text();
    throw new Error(`Overpass request failed: HTTP ${res.status}\n${body.slice(0, 300)}`);
  }
}

function loadJson(p) {
  return JSON.parse(readFileSync(p, 'utf8'));
}
function saveJson(p, data) {
  writeFileSync(p, JSON.stringify(data, null, 2) + '\n');
}

function haversineMeters([lon1, lat1], [lon2, lat2]) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function lineLengthKm(wayMembers) {
  let totalM = 0;
  for (const way of wayMembers) {
    const pts = way.geometry || [];
    for (let i = 1; i < pts.length; i++) {
      totalM += haversineMeters([pts[i - 1].lon, pts[i - 1].lat], [pts[i].lon, pts[i].lat]);
    }
  }
  return Math.round((totalM / 1000) * 10) / 10; // 1 d.p. km
}

// railway=platform ways/relations tag each physical edge with a ref like
// "12a"/"12b" (two faces of platform 12) — sometimes a multipolygon groups
// several refs into one "10a;10b;11a;11b" tag. Counting distinct numeric
// prefixes gives the real platform count instead of double-counting faces.
// Metro/tram platforms (network=West Midlands Metro etc, tagged tram=yes)
// are a different mode and deliberately excluded from a National Rail count.
function countPlatforms(elements) {
  const numbers = new Set();
  for (const el of elements) {
    const tags = el.tags || {};
    if (tags.tram === 'yes' || (tags.network || '').toLowerCase().includes('metro')) continue;
    const refs = (tags.ref || '').split(';').map((s) => s.trim()).filter(Boolean);
    for (const ref of refs) {
      const m = ref.match(/^(\d+)/);
      if (m) numbers.add(m[1]);
    }
  }
  return numbers.size || null;
}

const SERVICE_TYPE_LABELS = {
  commuter: 'Commuter/suburban',
  regional: 'Regional',
  long_distance: 'Long-distance',
  high_speed: 'High-speed',
  night: 'Sleeper',
  replacement: 'Rail replacement',
  tourism: 'Tourist/heritage',
};

async function enrichStation(crs) {
  console.log(`\n── station ${crs} ──`);
  const stationQ = `[out:json][timeout:25];node["ref:crs"="${crs}"];out tags;`;
  const stationRes = await overpassQuery(stationQ);
  const node = stationRes.elements[0];
  if (!node) {
    console.warn(`  no OSM node tagged ref:crs=${crs} — nothing to merge, left for manual curation.`);
    return { crs, incomplete: true, notes: `No OSM node found with ref:crs=${crs}.` };
  }
  const tags = node.tags || {};

  await sleep(150); // small pacing against the local instance — not fair-use politeness anymore, just avoids hammering a single-threaded query pipeline
  const platformQ = `[out:json][timeout:25];node(${node.id})->.stn;(way(around.stn:300)["railway"="platform"];relation(around.stn:300)["railway"="platform"];);out tags;`;
  const platformRes = await overpassQuery(platformQ);
  const platforms = countPlatforms(platformRes.elements);

  await sleep(150);
  // Which route relations genuinely STOP here → whose "brand" (preferred) or
  // "operator" tag names the TOC actually running trains through this
  // station. This is the OSM-derived counterpart to stations.operators.
  //
  // Switched 2026-07-13 from pure 250m proximity (any relation whose path
  // passes nearby, stopping or not) to PTv2 stop-role MEMBERSHIP checking —
  // same discipline enrichRoute() below already uses for stopping_stations.
  // Confirmed live that pure proximity produces real false positives:
  // "Southern Railway" / "Greater Thameslink Railway" were informally-tagged
  // relations picked up by dozens of nearby stations they didn't actually
  // serve; "National Express" at Newcastle Central was a single stale,
  // unmaintained relation with no stop-role tagging at all; even correctly-
  // named, genuinely real operators had individual false-positive stations
  // (Grand Central was never a real stop at Doncaster despite an ECML
  // relation passing nearby; Lumo likewise at Alexandra Palace).
  //
  // One combined proximity query still finds the CANDIDATE relations (this
  // is unavoidable — PTv2 stop-position nodes are separate objects from the
  // railway=station node itself, see the nameToCrs comment above, so a
  // direct-membership query on the station node alone finds nothing). What's
  // new is verifying each candidate before trusting it: does the relation's
  // own stop-role member list actually include this station?
  const relQ = `[out:json][timeout:25];node(${node.id})->.stn;rel(around.stn:250)["type"="route"]["route"~"^(train|light_rail|tram)$"];out body;`;
  const relRes = await overpassQuery(relQ);
  const relations = relRes.elements.filter((r) => r.type === 'relation');

  // Every candidate relation's stop-role members get resolved in ONE
  // batched query, not one query per relation — same cost discipline as
  // every other query in this function. A relation with zero stop-role
  // members (no PTv2 tagging at all, like the National Express case) can't
  // be verified either way — excluded from operators rather than guessed,
  // but tallied below so it's visible in _osm.notes instead of silently
  // vanishing.
  const stopMemberIds = new Set();
  for (const rel of relations) {
    for (const m of rel.members || []) {
      if (m.type === 'node' && ['stop', 'stop_entry_only', 'stop_exit_only'].includes(m.role)) {
        stopMemberIds.add(m.ref);
      }
    }
  }
  let stopNameById = {};
  if (stopMemberIds.size) {
    await sleep(150);
    const stopTagRes = await overpassQuery(`[out:json][timeout:25];node(id:${[...stopMemberIds].join(',')});out tags;`);
    stopNameById = Object.fromEntries(stopTagRes.elements.map((e) => [e.id, normalizeStationName((e.tags || {}).name)]));
  }

  const targetNorm = normalizeStationName(tags.name);
  const operators = [];
  const seenOperators = new Set();
  let unverifiedRelations = 0;
  for (const rel of relations) {
    const opName = rel.tags && (rel.tags.brand || rel.tags.operator);
    if (!opName) continue;
    const stopMembers = (rel.members || []).filter((m) => m.type === 'node' && ['stop', 'stop_entry_only', 'stop_exit_only'].includes(m.role));
    if (!stopMembers.length) {
      unverifiedRelations++;
      continue;
    }
    const isGenuineStop = stopMembers.some((m) => stopNameById[m.ref] === targetNorm);
    if (isGenuineStop && !seenOperators.has(opName)) {
      seenOperators.add(opName);
      operators.push(opName);
    }
  }

  const result = {
    platforms,
    wheelchair: tags.wheelchair || null,
    operators: operators.length ? operators : null,
  };
  const incomplete = platforms == null || !tags.wheelchair || !operators.length;
  const notes = [];
  if (platforms == null) notes.push('no railway=platform ways/relations found nearby — platform count unset');
  if (!tags.wheelchair) notes.push('station node has no wheelchair=* tag');
  if (!operators.length) notes.push('no route relations found stopping here — operators list unset');
  if (unverifiedRelations) notes.push(`${unverifiedRelations} relation(s) found via proximity but couldn't verify stop membership (no PTv2 stop-role tagging) — excluded, but manual review may find real coverage`);
  if (tags.wikipedia) notes.push(`hint: OSM tags this station's Wikipedia page as "${tags.wikipedia.replace(/^en:/, '')}" — consider setting wikipedia_title (not auto-applied)`);

  console.log(`  platforms=${platforms}  wheelchair=${tags.wheelchair || '(none)'}  operators=${operators.join(', ') || '(none)'}`);
  if (notes.length) console.log(`  ⚑ ${notes.join(' / ')}`);

  return { crs, node_id: node.id, result, incomplete, notes: notes.join('; ') || null };
}

async function findRouteRelation(job) {
  if (job.relationId) return job.relationId;
  const [s, w, n, e] = job.bbox || [49.5, -8.5, 61.0, 2.0]; // GB-wide fallback, per Task 1's Overpass usage — slow, prefer a real bbox
  const q = `[out:json][timeout:25][bbox:${s},${w},${n},${e}];relation["type"="route"]["route"~"^(train|light_rail|tram)$"]["name"~"${job.name.replace(/"/g, '')}",i];out tags;`;
  const res = await overpassQuery(q);
  if (res.elements.length === 1) return res.elements[0].id;
  return { ambiguous: res.elements.length > 1, candidates: res.elements.map((e) => ({ id: e.id, name: e.tags.name })) };
}

async function enrichRoute(job) {
  console.log(`\n── route ${job.slug} ──`);
  const relationIdOrAmbiguity = await findRouteRelation(job);
  if (typeof relationIdOrAmbiguity !== 'number') {
    const { ambiguous, candidates } = relationIdOrAmbiguity;
    const notes = ambiguous
      ? `${candidates.length} candidate OSM route relations matched "${job.name}" — ambiguous, needs a human to pick the right one and set relationId: ${candidates.map((c) => `${c.id} (${c.name})`).join(', ')}`
      : `No OSM public_transport route relation found matching "${job.name}" in the given bbox. This is a genuine content gap, not a bug — stopping_stations/length_km need manual curation for this route (or a wider/corrected bbox + retry).`;
    console.warn(`  ⚑ ${notes}`);
    return { slug: job.slug, incomplete: true, notes, result: {} };
  }
  const relationId = relationIdOrAmbiguity;

  await sleep(150);
  const relQ = `[out:json][timeout:25];relation(${relationId});out body geom;out tags;`;
  const relRes = await overpassQuery(relQ);
  const rel = relRes.elements.find((e) => e.type === 'relation');
  const ways = rel.members.filter((m) => m.type === 'way' && m.role === '');
  const stopMembers = rel.members.filter((m) => ['stop', 'stop_entry_only', 'stop_exit_only'].includes(m.role) && m.type === 'node');

  const length_km = ways.length ? lineLengthKm(ways) : null;

  let stopping_stations = null;
  const notes = [];
  if (!stopMembers.length) {
    notes.push('relation has no stop-role members — stopping order needs manual curation');
  } else {
    await sleep(150);
    const ids = stopMembers.map((m) => m.ref).join(',');
    const tagRes = await overpassQuery(`[out:json][timeout:25];node(id:${ids});out tags;`);
    const tagsById = Object.fromEntries(tagRes.elements.map((e) => [e.id, e.tags || {}]));
    const ordered = [];
    const unresolvedNames = [];
    for (const m of stopMembers) {
      const t = tagsById[m.ref] || {};
      // ref:crs is checked first as a fast path (some stop nodes do carry
      // it), name-match against station-list.json is the real fallback —
      // see the comment above nameToCrs for why that's necessary here.
      const crs = t['ref:crs'] || nameToCrs.get(normalizeStationName(t.name)) || null;
      if (crs) {
        if (ordered[ordered.length - 1] !== crs) ordered.push(crs); // dedupe consecutive entry/exit-only pairs at the same station
      } else {
        unresolvedNames.push(t.name || `node ${m.ref}`);
      }
    }
    stopping_stations = ordered.length ? ordered : null;
    if (unresolvedNames.length) notes.push(`${unresolvedNames.length} stop member(s) didn't match any station-list.json entry by name and were skipped: ${unresolvedNames.join(', ')} — review against the full stop list before trusting this order`);
  }

  const serviceTag = (rel.tags || {}).service;
  const type = serviceTag ? (SERVICE_TYPE_LABELS[serviceTag] || serviceTag) : null;
  if (serviceTag && !SERVICE_TYPE_LABELS[serviceTag]) notes.push(`unrecognized OSM service=${serviceTag} tag, used raw value for "type" — review`);

  const operator = (rel.tags || {}).brand || (rel.tags || {}).operator || null;
  if ((rel.tags || {}).wikipedia) notes.push(`hint: OSM tags this route's Wikipedia page as "${(rel.tags.wikipedia).replace(/^en:/, '')}" — consider setting wikipedia_title (not auto-applied)`);

  console.log(`  relation=${relationId}  length_km=${length_km}  stops=${stopping_stations ? stopping_stations.length : 0}  type=${type}  operator=${operator}`);
  if (notes.length) console.log(`  ⚑ ${notes.join(' / ')}`);

  return {
    slug: job.slug,
    relation_id: relationId,
    incomplete: length_km == null || !stopping_stations || notes.length > 0,
    notes: notes.join('; ') || null,
    result: { length_km, stopping_stations, type, operator },
  };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function mergeOsmFields(entry, fields) {
  const out = { ...(entry || {}) };
  for (const [k, v] of Object.entries(fields)) {
    if (v !== null && v !== undefined) out[k] = v; // only overwrite when OSM actually has a value — never blank out a manually curated field with a null
  }
  return out;
}

async function main() {
  const stationsContent = loadJson(STATIONS_PATH);
  const routesContent = loadJson(ROUTES_PATH);
  const report = { stations: [], routes: [] };

  // Save after EVERY station/route, not once at the very end — validated
  // against a real bulk run (2026-07-13, 100-station batch): the public
  // Overpass instance rate-limits hard enough that some entry eventually
  // exhausts overpassQuery()'s retry budget and throws, and with a single
  // save-at-the-end this silently discarded every station already fetched
  // (7 successful stations lost to one 8th-station failure in that run).
  // Each per-station catch below turns that into a soft failure — logged
  // and flagged in the report, not a reason to abort remaining stations.
  for (const crs of JOBS.stations) {
    try {
      const { result, incomplete, notes, node_id } = await enrichStation(crs);
      if (result) {
        stationsContent[crs] = mergeOsmFields(stationsContent[crs], result);
        stationsContent[crs]._osm = { fetched_at: new Date().toISOString(), node_id: node_id || null, incomplete: !!incomplete, notes: notes || null };
      }
      report.stations.push({ crs, incomplete, notes });
    } catch (err) {
      console.error(`  ${crs}: FAILED — ${err.message} (left untouched, continuing to next station)`);
      report.stations.push({ crs, incomplete: true, notes: `FAILED: ${err.message}` });
    }
    saveJson(STATIONS_PATH, stationsContent);
    await sleep(150);
  }

  for (const job of JOBS.routes) {
    try {
      const { slug, result, incomplete, notes, relation_id } = await enrichRoute(job);
      routesContent[slug] = mergeOsmFields(routesContent[slug], result);
      routesContent[slug]._osm = { fetched_at: new Date().toISOString(), relation_id: relation_id || null, incomplete: !!incomplete, notes: notes || null };
      report.routes.push({ slug, incomplete, notes });
    } catch (err) {
      console.error(`  ${job.slug}: FAILED — ${err.message} (left untouched, continuing to next route)`);
      report.routes.push({ slug: job.slug, incomplete: true, notes: `FAILED: ${err.message}` });
    }
    saveJson(ROUTES_PATH, routesContent);
    await sleep(150);
  }

  console.log('\n=== Summary (needs-your-judgment flagged with ⚑) ===');
  for (const s of report.stations) console.log(`station ${s.crs}: ${s.incomplete ? '⚑ ' + s.notes : 'OK'}`);
  for (const r of report.routes) console.log(`route ${r.slug}: ${r.incomplete ? '⚑ ' + r.notes : 'OK'}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
