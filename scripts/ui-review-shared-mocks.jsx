import { createPortal } from "react-dom";
const baby={name:"River",nickname:null,sex:"female",timezone:"UTC",settings:{}};
const state={baby,family:{id:99,care_name:"Sam",ask:"an owner"},me:{email:"sam@example.test",role:"owner"},care:{person:{name:"Sam"}},entries:[]};
export const useMaple=()=>({state,readOnly:false,units:"us",now:()=>new Date("2026-10-28T12:00:00Z"),toast(){}});
export const useNow=()=>new Date("2026-10-28T12:00:00Z");
export const useCare=()=>({self:true,name:"Sam",state:{settings:{care_team:{}},person:{name:"Sam"}},access:{write:true}});
export const useCareNav=()=>({openSupport(){},openHelp(){},openDoctor(){}});
export const useSheets=()=>({open(){},close(){}});
export const useHoldTimerToasts=()=>{};
export const useTimerActions=()=>({});
export const OnTop=({children})=>createPortal(children,document.body);
export const useNotifications=()=>({open(){},value:"Off"});
export const NotificationsRow=()=>null;
export class ApiError extends Error {}
