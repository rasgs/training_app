// Seed data: band inventory and progression ladders.
// Everything here is editable in the app; these are only first-launch defaults.

// Typical loop "power bands". Colors and kg ranges differ by brand, so users edit them.
export const DEFAULT_BANDS = [
  { name: 'Yellow', color: '#f2d22e', widthMm: 6, minKg: 2, maxKg: 7 },
  { name: 'Red', color: '#d6312b', widthMm: 13, minKg: 7, maxKg: 16 },
  { name: 'Black', color: '#262626', widthMm: 21, minKg: 11, maxKg: 25 },
  { name: 'Purple', color: '#7a3fb0', widthMm: 32, minKg: 16, maxKg: 39 },
  { name: 'Green', color: '#2f9a4a', widthMm: 44, minKg: 23, maxKg: 57 },
  { name: 'Blue', color: '#2a62c9', widthMm: 64, minKg: 30, maxKg: 80 },
];

// Progression ladders follow the r/bodyweightfitness progression chart (v5.4,
// based on Overcoming Gravity). RTO = rings turned out.
// equipment: 'bar' | 'rings' | 'none' (floor, wall, parallettes).
// bands / weight: whether resistance bands / added weight make sense for this skill.
// kind: 'static' -> value is hold seconds; 'reps' -> value is repetitions.
// goal: the hold/reps at the current level, without assistance, that means "ready to move up".
export const TEMPLATES = [
  // ---- Pull ----
  { name: 'Front lever', equipment: 'bar', bands: true, weight: false, kind: 'static', group: 'Pull', goal: 15,
    levels: ['Tuck front lever', 'Adv tuck front lever', 'One leg front lever', 'Straddle front lever', 'Front lever'] },
  { name: 'Back lever', equipment: 'rings', bands: true, weight: false, kind: 'static', group: 'Pull', goal: 15,
    levels: ['German hang', 'Tuck back lever', 'Adv tuck back lever', 'One leg back lever', 'Straddle back lever', 'Back lever'] },
  { name: 'Pull-up', equipment: 'bar', bands: true, weight: true, kind: 'reps', group: 'Pull', goal: 8,
    levels: ['Scapular pull', 'Arch hang', 'Pull-up negative', 'Pull-up', 'L-sit pull-up', 'Chest-to-bar pull-up',
      'Wide pull-up', 'Typewriter pull-up', 'Archer pull-up', 'One-arm pull-up negative', 'One-arm pull-up'] },
  { name: 'Row', equipment: 'rings', bands: false, weight: true, kind: 'reps', group: 'Pull', goal: 10,
    levels: ['Vertical row', 'Incline row', 'Row', 'Wide row', 'Archer row', 'Tuck front lever row',
      'Adv tuck front lever row', 'Straddle front lever row', 'Front lever row'] },
  { name: 'Muscle-up', equipment: 'bar', bands: true, weight: false, kind: 'reps', group: 'Pull', goal: 5,
    levels: ['Muscle-up negative', 'Kipping muscle-up', 'Strict bar muscle-up', 'Wide muscle-up', 'L-sit muscle-up'] },
  { name: 'Human flag', equipment: 'bar', bands: false, weight: false, kind: 'static', group: 'Pull', goal: 10,
    levels: ['Side plank', 'Support press', 'Vertical flag', 'Tuck flag', 'Adv tuck flag', 'Straddle flag', 'Human flag'] },

  // ---- Push ----
  { name: 'Planche', equipment: 'none', bands: true, weight: false, kind: 'static', group: 'Push', goal: 15,
    levels: ['Planche lean', 'Frog stand', 'Straight-arm frog stand', 'Tuck planche', 'Adv tuck planche',
      'Straddle planche', 'One leg planche', 'Planche'] },
  { name: 'Elbow lever', equipment: 'none', bands: false, weight: false, kind: 'static', group: 'Push', goal: 15,
    levels: ['Straddle elbow lever', 'One leg elbow lever', 'Elbow lever', 'Ring elbow lever',
      'One-arm straddle elbow lever', 'One-arm elbow lever'] },
  { name: 'Handstand', equipment: 'none', bands: false, weight: false, kind: 'static', group: 'Push', goal: 60,
    levels: ['Wall plank', 'Wall headstand', 'Headstand', 'Wall handstand', 'Handstand'] },
  { name: 'HSPU', equipment: 'none', bands: false, weight: false, kind: 'reps', group: 'Push', goal: 8,
    levels: ['Pike push-up', 'Decline pike push-up', 'Wall headstand push-up negative', 'Wall headstand push-up',
      'Headstand push-up', 'Wall handstand push-up', 'Handstand push-up'] },
  { name: 'Push-up', equipment: 'none', bands: true, weight: true, kind: 'reps', group: 'Push', goal: 15,
    levels: ['Incline push-up', 'Push-up', 'Diamond push-up', 'Pseudo planche push-up', 'Archer push-up',
      'Incline one-arm push-up', 'Straddle one-arm push-up', 'One-arm push-up'] },
  { name: 'Ring push-up', equipment: 'rings', bands: false, weight: true, kind: 'reps', group: 'Push', goal: 12,
    levels: ['Ring wide push-up', 'Ring push-up', 'RTO push-up', 'RTO archer push-up', 'RTO pseudo planche push-up',
      'Ring straddle one-arm push-up', 'Ring one-arm push-up'] },
  { name: 'Dip', equipment: 'bar', bands: true, weight: true, kind: 'reps', group: 'Push', goal: 10,
    levels: ['Dip negative', 'Dip', 'L-sit dip'] },
  { name: 'Ring dip', equipment: 'rings', bands: true, weight: true, kind: 'reps', group: 'Push', goal: 10,
    levels: ['Ring dip negative', 'Ring dip', 'RTO dip', 'Bulgarian dip', 'Ring L-sit dip', 'Ring wide dip',
      'RTO 45° dip', 'RTO 90° dip'] },
  { name: 'Bridge', equipment: 'none', bands: false, weight: false, kind: 'static', group: 'Push', goal: 30,
    levels: ['Reverse plank', 'Shoulder bridge', 'Table bridge', 'Angled bridge', 'Head bridge', 'Bridge / wheel',
      'Decline bridge', 'One leg bridge'] },

  // ---- Core ----
  { name: 'L-sit', equipment: 'none', bands: false, weight: false, kind: 'static', group: 'Core', goal: 30,
    levels: ['Foot-supported L-sit', 'One leg bent L-sit', 'Tuck L-sit', 'One leg L-sit', 'L-sit', 'Straddle L-sit',
      'RTO L-sit', '45° V-sit', '90° V-sit', '120° V-sit', '140° V-sit', '155° V-sit', '170° V-sit', 'Manna'] },
  { name: 'Hanging leg raise', equipment: 'bar', bands: false, weight: true, kind: 'reps', group: 'Core', goal: 10,
    levels: ['Hanging knees to chest', 'Hanging leg raise (toes to bar)', 'Ankle-weight hanging leg raise', 'One-arm hanging leg raise'] },
  { name: 'Ab wheel', equipment: 'none', bands: false, weight: false, kind: 'reps', group: 'Core', goal: 10,
    levels: ['Knees ab wheel', 'Straight-leg ab wheel (ramp)', 'Straight-leg ab wheel negative', 'Straight-leg ab wheel',
      'Weighted ab wheel', 'One-arm ab wheel'] },
  { name: 'Dragon flag', equipment: 'none', bands: false, weight: false, kind: 'reps', group: 'Core', goal: 5,
    levels: ['Tuck dragon flag negative', 'Adv tuck dragon flag', 'Straddle / one leg dragon flag', 'Dragon flag',
      'Ankle-weight dragon flag', 'One-arm dragon flag'] },

  // ---- Legs ----
  { name: 'Squat', equipment: 'none', bands: false, weight: true, kind: 'reps', group: 'Legs', goal: 10,
    levels: ['Assisted squat', 'Parallel squat', 'Full squat', 'Cossack squat', 'Partial pistol squat',
      'Assisted pistol squat', 'Pistol squat', 'Weighted pistol squat'] },
  { name: 'Shrimp squat', equipment: 'none', bands: false, weight: true, kind: 'reps', group: 'Legs', goal: 8,
    levels: ['Split squat', 'Bulgarian split squat', 'Beginner shrimp squat', 'Intermediate shrimp squat', 'Shrimp squat',
      'Two-hand shrimp squat', 'Elevated two-hand shrimp squat'] },
  { name: 'Nordic curl', equipment: 'none', bands: true, weight: false, kind: 'reps', group: 'Legs', goal: 5,
    levels: ['90° hip nordic curl', '45° hip nordic curl', 'Nordic curl negative', 'Nordic curl',
      'Tuck one leg nordic curl', 'One leg nordic curl'] },
  { name: 'Step-up', equipment: 'none', bands: false, weight: true, kind: 'reps', group: 'Legs', goal: 10,
    levels: ['Step-up', 'Deep step-up', 'Single-leg deadlift'] },
];

export const GROUPS = ['Push', 'Pull', 'Core', 'Legs', 'Other'];

// Execution style for rep exercises. Standard (null) is the default.
export const TEMPOS = { explosive: 'Explosive', slow: 'Slow', paused: 'Paused' };

export const EQUIPMENT = { bar: 'Bar', rings: 'Rings', none: 'None' };
