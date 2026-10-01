// Paperball — shared configuration. Owned by integrator.
export const IS_MOBILE =
  /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent) ||
  ('ontouchstart' in window && navigator.maxTouchPoints > 1);

export const CONFIG = {
  // Default location: downtown Enid, OK. Override with ?q=<address> or ?lat=..&lon=..
  default_center: { lat: 36.3956, lon: -97.8784, label: 'Enid, OK' },

  radius_m:        IS_MOBILE ? 160 : 260,   // Overpass bbox half-size
  max_buildings:   IS_MOBILE ? 180 : 450,
  max_trees:       IS_MOBILE ? 120 : 400,

  target_count:    10,
  target_speed:    1.2,          // m/s
  paintball_speed: 40,           // m/s
  paintball_radius: 0.06,
  gravity:         -20,
  player_height:   1.7,
  player_radius:   0.35,
  move_speed:      6,
  sprint_multiplier: 2.0,
  jump_speed:      7,
  mouse_sensitivity: 0.0022,
  touch_sensitivity: 0.0045,
  max_paintballs:  IS_MOBILE ? 30 : 50,
  max_splats:      IS_MOBILE ? 80 : 200,
  max_cannon_bodies: 500,

  pixel_ratio_cap: IS_MOBILE ? 1 : 1.5,
  fog_near:        IS_MOBILE ? 50 : 90,
  fog_far:         IS_MOBILE ? 170 : 320,
  outlines:        true,
};
