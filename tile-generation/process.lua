-- SpotRail HQ minimal railway-line profile for tilemaker.
-- Outputs a single "railways" vector layer, LineString geometry only.
--
-- Output schema (must match map.html's railwayLineColorExpression()):
--   kind:   "rail" | "light_rail" | "tram" | "subway" | "narrow_gauge"
--           | "monorail" | "funicular"
--   status: "active" | "disused" | "abandoned" | "construction"

local RAIL_KINDS = {
  rail = true, light_rail = true, tram = true, subway = true,
  narrow_gauge = true, monorail = true, funicular = true,
}

function way_function()
  local railway = Find("railway")
  if railway == "" then return end

  local kind, status

  if RAIL_KINDS[railway] then
    kind, status = railway, "active"
  elseif railway == "disused" then
    kind, status = "rail", "disused"
  elseif railway == "abandoned" then
    kind, status = "rail", "abandoned"
  elseif railway == "construction" then
    kind, status = "rail", "construction"
  else
    return -- platform, station, signal_box, buffer_stop, crossing, etc — not wanted
  end

  -- The more common real-world OSM tagging pattern is railway=rail PLUS
  -- disused=yes/abandoned=yes, rather than railway=disused/abandoned
  -- directly — catch that too, so the "Closed" status isn't undercounted.
  if Find("disused") == "yes" then status = "disused" end
  if Find("abandoned") == "yes" then status = "abandoned" end

  Layer("railways", false)
  Attribute("kind", kind)
  Attribute("status", status)
  local name = Find("name")
  if name ~= "" then Attribute("name", name) end
end

function node_function()
  -- intentionally empty — no point features in this profile
end