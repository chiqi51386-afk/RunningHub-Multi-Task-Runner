/** Audited workflow identities. Never infer prompt targets from display labels. */
export const H3_OPTIMIZATION_ROUTES: Record<string, {prompt:string; duration:string; ratio:string; consumer:string; images:string[]; qwen:boolean; keyframes?:boolean; audio?:string; start?:string}> = {
  '2107063778012905474': {prompt:'87.value',duration:'85.duration',ratio:'61.aspect_ratio',consumer:'42',images:['36','88','89','90','91','92'],qwen:false,audio:'34.audio',start:'85.start_index'},
  '2106994828660080641': {prompt:'247.text',duration:'132.value',ratio:'115.aspect_ratio',consumer:'136',images:['150','222'],qwen:false,keyframes:true},
  '2106577322987307010': {prompt:'247.text',duration:'132.value',ratio:'115.aspect_ratio',consumer:'136',images:['150','222','223','240','241','242','243','244','245'],qwen:false},
  '2104088262948556801': {prompt:'325.text',duration:'259.value',ratio:'252.aspect_ratio',consumer:'265',images:['51','49','50','43','19','23'],qwen:true},
  '2104087390590894081': {prompt:'232.value',duration:'132.value',ratio:'115.aspect_ratio',consumer:'136',images:['150','164','239','241','240','238'],qwen:true},
};
// Already submitted jobs retain their original graph.
H3_OPTIMIZATION_ROUTES['2104166509705986049'] = H3_OPTIMIZATION_ROUTES['2107063778012905474']!;
