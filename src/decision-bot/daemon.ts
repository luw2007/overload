#!/usr/bin/env bun
import { openMailbox } from "./mailbox";
import { DecisionBotService } from "./service";
const db=openMailbox();const service=new DecisionBotService(db);let stopped=false;for(const signal of ["SIGINT","SIGTERM"] as const)process.on(signal,()=>{stopped=true;});try{while(!stopped){await service.tick();await Bun.sleep(2000);}}finally{db.close();}
