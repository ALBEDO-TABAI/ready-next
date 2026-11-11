// Build first. Launches one isolated Ready profile; CALENDAR_CDP_URL can attach to an existing test profile.
const {chromium,_electron}=require('playwright');
const path=require('node:path');const os=require('node:os');const {createServer}=require('node:http');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const results=[];
(async()=>{
 let app,browser,page;
 const profile=fs.mkdtempSync(path.join(os.tmpdir(),'ready-calendar-acceptance-'));
 fs.mkdirSync('outputs/calendar-union',{recursive:true});
 // Other modules are reached through the workbench too (the rail has no English titles since W2).
 const showMode=async(mode,selector)=>{
   for(let i=0;i<100&&!await page.locator(selector).isVisible().catch(()=>false);i++){
     await page.evaluate(mode=>window.dispatchEvent(new CustomEvent('ready:workbench-mode-change-request',{detail:{mode,placement:'open',presentation:'immediate'}})),mode);await page.waitForTimeout(200)}
   await page.locator(selector).waitFor();
 };
 // 导入 lives in the 新建日历 menu (W4 §4); the dialog is answered by the stubbed native picker.
 // The calendar follows Ready's interface language (Simplified Chinese) unless the person picked another (B9).
 const importFromMenu=async()=>{await page.locator('.ready-calendar .side-row',{hasText:'新建日历'}).click();await page.getByRole('menuitem',{name:'导入 .ics…'}).click()};
 // The shell rail has no English titles (W2): ask the workbench for the calendar until its grid shows.
 const showCalendar=async()=>{
   for(let i=0;i<100&&!await page.locator('[data-testid=timegrid]').isVisible().catch(()=>false);i++){
     await page.evaluate(()=>window.dispatchEvent(new CustomEvent('ready:workbench-mode-change-request',{detail:{mode:'calendar',placement:'open',presentation:'immediate'}})));await page.waitForTimeout(200)}
   await page.locator('[data-testid=timegrid]').waitFor();
 };
 const launch=async()=>{
  const env={...process.env,READY_USER_DATA_DIR:profile,READY_START_HIDDEN:'1'};delete env.ELECTRON_RUN_AS_NODE;
  app=await _electron.launch({executablePath:require('electron'),args:[process.cwd()],env,timeout:45000});
  const deadline=Date.now()+90000;
  while(Date.now()<deadline){page=app.windows().find(p=>p.url().includes('/renderer/index.html'));if(page)break;await new Promise(r=>setTimeout(r,250))}
  assert.ok(page,'Ready renderer started');
  await app.evaluate(({BrowserWindow})=>{for(const w of BrowserWindow.getAllWindows())if(w.webContents.getURL().includes('/renderer/index.html'))w.setSize(1800,1000)});
  await showCalendar();
 };
 if(process.env.CALENDAR_CDP_URL){browser=await chromium.connectOverCDP(process.env.CALENDAR_CDP_URL);page=browser.contexts()[0].pages().find(p=>p.url().includes('/renderer/index.html'))}else await launch();
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 // The app root; since W2 the calendar's sidebar renders in the shell navigator under its own .ready-calendar scope.
 let root=page.locator('[data-testid=ready-calendar]');
 const api=async(method,...args)=>page.evaluate(async({method,args})=>{const r=await window.electronAPI.calendar[method](...args);if(!r.success)throw Error(r.error);return r.data},{method,args});
 const snap=()=>api('snapshot');const events=async()=>(await snap()).events;
 const ok=(name,pass,detail='')=>{results.push({name,pass:!!pass,detail});console.log(`${pass?'PASS':'FAIL'} ${name}`);assert.ok(pass,`${name}: ${detail}`)};
 const idle=async()=>{await page.waitForTimeout(120);await page.waitForFunction(()=>!document.querySelector('.calendar-save-status:not(.error)'));const alert=root.locator('[role=alert]');const error=await alert.count()?await alert.textContent():null;if(error)throw Error(error)};
 const key=async(k)=>{await page.keyboard.press(process.platform==='darwin'?k.replace('Control+','Meta+'):k);await idle()};
 const focus=()=>root.focus();
 const settle=async(selector)=>page.locator(selector).evaluate(el=>new Promise(resolve=>{let prev='',stable=0,frames=0;const tick=()=>{const r=el.getBoundingClientRect(),v=[r.x,r.y,r.width,r.height].join(':');stable=v===prev?stable+1:0;prev=v;if(stable>=8||++frames>180)return resolve();requestAnimationFrame(tick)};tick()}));
 const geo=()=>page.evaluate(()=>{const g=document.querySelector('[data-testid=timegrid]'),sc=g.querySelector('.scroller'),r=sc.getBoundingClientRect();return{x:r.x,y:r.y,st:sc.scrollTop,gutter:+g.dataset.gutter,colW:+g.dataset.colw,hourH:+g.dataset.hourh}});
 const pt=async(d,m)=>{const g=await geo();return{x:g.x+g.gutter+(d+.5)*g.colW,y:g.y+m/60*g.hourH-g.st}};
 const drag=async(a,b)=>{await page.mouse.move(a.x,a.y);await page.mouse.down();await page.mouse.move(b.x,b.y,{steps:10});await page.mouse.up();await idle()};
 const scroll=()=>page.evaluate(()=>{const g=document.querySelector('[data-testid=timegrid]');g.querySelector('.scroller').scrollTop=8*+g.dataset.hourh});
 try{
  // Set up through the production IPC. No browser-only store or demo fixtures.
  const before=await snap();if(before.events.length){await api('restore',{put:[],remove:before.events.map(e=>e.id)},Object.fromEntries(before.events.map(e=>[e.id,e.revision])))}
  await api('putPreferences',{primaryTimeZone:'Asia/Shanghai',locale:'zh-CN',gridView:'default',daysPerPeriod:7,weekStartsOn:0,showWeekends:true,sidebar:true,contextPanel:true,format24HourTime:false,notifications:false,additionalTimeZones:[]});
  await page.reload();await showCalendar();await root.locator('[data-testid=timegrid]').waitFor();await focus();await key('Period');await page.locator('[data-testid=goto] input').fill('2026-10-28');await key('Enter');await scroll();
  const start=Date.parse('2026-10-25T00:00:00+08:00');const at=(d,h,m=0)=>start+d*86400000+(h*60+m)*60000;
  await drag(await pt(1,602),await pt(1,658));let list=await events(),event=list[0],id=event?.id;
  ok('drag creates one event at 10–11',list.length===1&&event.start===at(1,10)&&event.end===at(1,11),JSON.stringify(list));
  ok('draft title receives focus',await page.locator('[data-testid=ev-title]').evaluate(el=>el===document.activeElement));
  await page.keyboard.type('验收日程');await key('Enter');ok('title saved to SQLite',(await events())[0].title==='验收日程');
  await page.locator('[data-testid=ev-title]').fill('取消的修改');await key('Escape');ok('title Escape preserves saved content',(await events())[0].title==='验收日程');
  await page.locator('[data-field=u]').fill('invalid-link');await page.keyboard.press('Meta+Enter');await root.locator('[role=alert]').waitFor();ok('failed edit shows error and does not persist',(await events())[0].url===undefined);await page.locator('[data-field=u]').fill('https://example.test/calendar');await key('Control+Enter');ok('correcting failed edit saves successfully',(await events())[0].url==='https://example.test/calendar');
  const chip=()=>page.locator(`.chip[data-key="${id}"]`).first().boundingBox();let b=await chip(),g=await geo();
  await drag({x:b.x+b.width/2,y:b.y+12},{x:b.x+b.width/2+g.colW,y:b.y+12+g.hourH/2});event=(await events())[0];ok('drag moves day and time',event.start===at(2,10,30)&&event.end===at(2,11,30),JSON.stringify({got:[new Date(event.start).toISOString(),new Date(event.end).toISOString()],want:[new Date(at(2,10,30)).toISOString(),new Date(at(2,11,30)).toISOString()],from:b,geo:g}));
  b=await chip();g=await geo();await drag({x:b.x+b.width/2,y:b.y+b.height-2},{x:b.x+b.width/2,y:b.y+b.height-2+g.hourH/2});ok('resize commits end time',(await events())[0].end===at(2,12));
  await page.locator('[data-field=l]').fill('会议室 A');await key('Control+Enter');ok('Cmd Enter saves focused input',(await events())[0].location==='会议室 A');
  await focus();await key('Backspace');ok('delete persists',(await events()).length===0);await key('Control+z');ok('undo restores',(await events()).length===1);await key('Control+Shift+z');ok('redo deletes',(await events()).length===0);await key('Control+z');
  await page.locator(`.chip[data-key="${id}"]`).first().click();await focus();await key('Control+d');ok('duplicate produces independent UID',new Set((await events()).map(e=>e.uid)).size===2);await key('Control+z');ok('undo duplicate preserves original',(await events()).length===1);
  await page.locator(`.chip[data-key="${id}"]`).first().click();await focus();await key('Control+c');await key('Control+v');ok('copy paste creates an independent event',(await events()).length===2&&new Set((await events()).map(e=>e.uid)).size===2);
  await key('Control+a');await key('Backspace');ok('multi-select delete commits the whole selection',(await events()).length===0);await key('Control+z');ok('multi-select undo restores both',(await events()).length===2);await key('Control+z');
  await page.locator(`.chip[data-key="${id}"]`).first().click();await focus();await key('Control+x');ok('cut removes selected persisted event',(await events()).length===0);await key('Control+z');ok('cut can be undone without losing source',(await events()).some(e=>e.id===id));
  await page.locator(`.chip[data-key="${id}"]`).first().click();await page.locator('[data-testid=ev-opts]').click();await page.locator('[data-testid=ev-repeat]').click();await page.locator('.mi',{hasText:'每天'}).first().click();await idle();ok('repeat rule persisted',(await events())[0].rrule==='FREQ=DAILY');ok('series renders instances',await page.locator(`.chip[data-key^="${id}|"]`).count()>=4);
  b=await page.locator(`.chip[data-key="${id}|${at(4,10,30)}"]`).first().boundingBox();g=await geo();await drag({x:b.x+b.width/2,y:b.y+12},{x:b.x+b.width/2,y:b.y+12+g.hourH});ok('recurring drag requests scope',await page.locator('[data-testid=scope]').isVisible());await page.locator('[data-testid=scope] .btn').first().click();await idle();const override=(await events()).find(e=>e.recurringEventId===id);ok('single change persists exact original identity',override?.start===at(4,11,30)&&override.originalStart===at(4,10,30));
  await focus();await key('Backspace');await page.locator('[data-testid=scope] .btn').nth(2).click();await idle();ok('delete all removes series and overrides',(await events()).length===0);
  // Calendar commands live in Ready's shared registry and show in the shell's ⌘K (W2), titled in Simplified Chinese.
  await focus();await page.keyboard.press(process.platform==='darwin'?'Meta+k':'Control+k');const field=page.getByRole('combobox',{name:'搜索所有对象和命令'});await field.waitFor();ok('command menu opens',await field.isVisible());
  await field.fill('月视图');await page.getByRole('option',{name:/切换到月视图/}).first().click();await idle();ok('command selects month',(await snap()).prefs.gridView==='month');
  for(const [k,view,days]of [['w','default',7],['d','default',1],['4','default',4],['m','month',4],['w','default',7]]){await focus();await key(k);const p=(await snap()).prefs;ok(`view shortcut ${k}`,p.gridView===view&&(view==='month'||p.daysPerPeriod===days))}
  // \ collapses and restores the shell sidebar that holds the calendar navigator.
  const sideWidth=()=>page.locator('[data-shell-sidebar]').evaluate(el=>el.getBoundingClientRect().width);
  await key('Backslash');await page.waitForFunction(()=>document.querySelector('[data-shell-sidebar]').getBoundingClientRect().width<1).catch(()=>{});ok('sidebar hide',await sideWidth()<1);
  await key('Backslash');await page.waitForFunction(()=>document.querySelector('[data-shell-sidebar]').getBoundingClientRect().width>100).catch(()=>{});ok('sidebar show',await sideWidth()>100);
  // The context panel is ⌘⌥\ in the shortcut registry (calendar.panel).
  await key('Control+Alt+Backslash');ok('panel hide',await root.locator('.panel').count()===0);await key('Control+Alt+Backslash');ok('panel show',await root.locator('.panel').count()===1);
  await key('Shift+Slash');ok('shortcuts visible',await page.locator('[data-testid=search]').getAttribute('placeholder')==='搜索快捷键'&&(await root.innerText()).includes('导航'));await key('Escape');await focus();await key('Period');ok('date navigation opens',await page.locator('[data-testid=goto]').isVisible());await page.locator('[data-testid=goto] input').fill('2026-12-25');await key('Enter');ok('date navigation changes month',(await page.locator('[data-testid=title]').innerText()).includes('十二月'));await key('t');
  // Calendar settings are a section of Ready's settings (W2); the app menu's 日历设置… opens them.
  if(app){
    await app.evaluate(({Menu})=>Menu.getApplicationMenu().getMenuItemById('ready-calendar-menu').submenu.items.find(i=>i.label==='日历设置…').click());
    await page.waitForFunction(()=>location.hash.includes('section=calendar'));ok('settings open',true);
    await page.evaluate(()=>{location.hash='#/workbench'});await showCalendar();
  }
  await focus();const h0=(await geo()).hourH;await key('Control+Shift+Period');ok('zoom changes hour height',(await geo()).hourH>h0);await key('Control+Shift+Digit0');
  await key('Control+Shift+e');ok('weekends hidden',await root.locator('.colhead').count()===5);await key('Control+Shift+e');
  await key('c');await page.keyboard.type('字段保存');await key('Enter');ok('create shortcut saves event',(await events()).some(e=>e.title==='字段保存'));
  await page.locator('[data-testid=ev-opts]').click();await page.locator('[data-testid=ev-repeat]').click();await page.locator('.mi',{hasText:'自定义'}).click();await page.locator('[data-testid=rec-interval]').fill('2');await page.locator('[data-testid=rec-end-count]').check();await page.locator('[data-testid=rec-count]').fill('3');await key('Control+Enter');ok('custom recurrence Cmd Enter saves from focused input',(await events()).some(e=>e.title==='字段保存'&&e.rrule?.includes('COUNT=3')));await focus();await key('Control+z');
  // Clear the selection using Escape twice, then availability is tested through its real controls.
  await focus();await key('Escape');await key('s');ok('availability panel opens',await page.locator('[data-testid=availpanel]').isVisible());await scroll();await drag(await pt(4,842),await pt(4,898));ok('availability drawing does not save an event',(await events()).length===1);await page.locator('[data-testid=av-holds]').click();await idle();ok('holds are tentative and free',(await events()).some(e=>e.status==='tentative'&&e.transparency==='transparent'));
  const ics=['BEGIN:VCALENDAR','VERSION:2.0','BEGIN:VEVENT','UID:accept-ny','DTSTART;TZID=America/New_York:20261028T090000','DTEND;TZID=America/New_York:20261028T100000','SUMMARY:纽约会议','END:VEVENT','BEGIN:VEVENT','UID:accept-day','DTSTART;VALUE=DATE:20261030','DTEND;VALUE=DATE:20261101','SUMMARY:两天活动','END:VEVENT','END:VCALENDAR'].join('\r\n');
  const imported=await api('importCalendar',ics,'验收导入');await idle();list=await events();ok('native import preserves TZID',list.find(e=>e.title==='纽约会议')?.start===Date.parse('2026-10-28T13:00Z'));ok('all day import preserves exclusive end',list.find(e=>e.title==='两天活动')?.end==='2026-11-01');const out=await api('exportIcs',imported.sourceId);ok('export preserves named timezone',out.includes('TZID="America/New_York"'));ok('export preserves all-day date',out.includes('DTEND;VALUE=DATE:20261101'));
  await focus();await key('Control+f');await page.locator('[data-testid=search]').fill('纽约');await idle();ok('search finds imported event',await page.locator('.side-row',{hasText:'纽约会议'}).count()===1);await page.locator('.side-row',{hasText:'纽约会议'}).click();await idle();ok('search opens event editor',await page.locator('[data-testid=ev-title]').innerText()==='纽约会议');
  const saved=await events();await page.reload();await showCalendar();await root.locator('[data-testid=timegrid]').waitFor();ok('reload preserves all saved records',JSON.stringify((await events()).map(e=>[e.id,e.title,e.start,e.end]))===JSON.stringify(saved.map(e=>[e.id,e.title,e.start,e.end])));
  await showMode('rss','.rss-mode-shell');await page.keyboard.press('d');await page.keyboard.press('c');ok('other module shortcuts do not create calendar events',(await events()).length===saved.length);
  await settle('.rss-mode-shell .workbench-canvas-shell');const rss=await page.locator('.rss-mode-shell .workbench-canvas-shell').boundingBox();await showCalendar();await root.locator('[data-testid=timegrid]').waitFor();await settle('.calendar-union-mode .workbench-canvas-shell');const cal=await page.locator('.calendar-union-mode .workbench-canvas-shell').boundingBox();ok('calendar boundaries match RSS',Math.abs(cal.x-rss.x)<1&&Math.abs(cal.y-rss.y)<1&&Math.abs(cal.width-rss.width)<1&&Math.abs(cal.height-rss.height)<1,JSON.stringify({cal,rss}));
  const style=await root.evaluate(el=>({root:getComputedStyle(el).backgroundColor,rows:[...document.querySelectorAll('.ready-calendar .mini-row')].map(e=>getComputedStyle(e).backgroundColor),panels:[...el.querySelectorAll('.sidebar,.main,.panel')].map(e=>({radius:getComputedStyle(e).borderRadius,shadow:getComputedStyle(e).boxShadow}))}));ok('no extra background or row pills',style.root==='rgba(0, 0, 0, 0)'&&style.rows.every(x=>x==='rgba(0, 0, 0, 0)'));ok('rounded cards without floating shadow',style.panels.every(x=>x.radius==='24px'&&x.shadow==='none'));
  let feed=ics;
  const server=createServer((_req,res)=>{res.writeHead(200,{'Content-Type':'text/calendar'});res.end(feed)});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  try{
    const sub=await api('subscribeUrl',{url:`http://127.0.0.1:${server.address().port}/calendar.ics`,name:'本地订阅验收'});
    ok('subscription writes real events',sub.initialEvents===2);
    const source=(await snap()).calendars.find(c=>c.id===sub.sourceId);ok('subscription source is read-only',source.readOnly);
    const count=(await events()).filter(e=>e.calendarId===sub.sourceId).length;
    feed=ics.replace('DTSTART;TZID=America/New_York:20261028T090000','DTSTART:invalid');
    let failed=false;try{await api('syncSourceNow',sub.sourceId)}catch{failed=true}
    ok('invalid subscription snapshot leaves existing data',failed&&(await events()).filter(e=>e.calendarId===sub.sourceId).length===count);
    feed=ics.replace('纽约会议','订阅更新');await api('syncSourceNow',sub.sourceId);await idle();
    ok('subscription update reaches the stored snapshot',(await events()).some(e=>e.calendarId===sub.sourceId&&e.title==='订阅更新'));
    await api('unsubscribeSource',sub.sourceId);ok('unsubscribe removes only that source',!(await events()).some(e=>e.calendarId===sub.sourceId)&&(await events()).some(e=>e.title==='纽约会议'));
  }finally{await new Promise(r=>server.close(r))}
  if(app){
    const file=path.join(profile,'roundtrip.ics'),output=path.join(profile,'export.ics');fs.writeFileSync(file,ics);
    await app.evaluate(({dialog},{file,output})=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[file]});dialog.showSaveDialog=async()=>({canceled:false,filePath:output})},{file,output});
    await importFromMenu();await idle();const importedCount=(await events()).length;
    await importFromMenu();await idle();ok('file chooser reimport keeps event count',(await events()).length===importedCount);
    await app.evaluate(({Menu})=>Menu.getApplicationMenu().getMenuItemById('ready-calendar-menu').submenu.items.find(i=>i.label==='导出全部日历…').click());
    await page.waitForTimeout(200);ok('native export writes an ICS file',fs.readFileSync(output,'utf8').includes('BEGIN:VCALENDAR'));
    await app.evaluate(({app})=>app.emit('open-url',{preventDefault(){}},'ready-next://calendar/day/2026-12-25'));
    await page.waitForFunction(()=>document.querySelector('[data-testid=title]')?.textContent.includes('十二月'));ok('native day deep link reaches calendar',true);
    const primary=(await snap()).calendars.find(c=>c.primary&&!c.readOnly).id;
    await api('putPreferences',{notifications:true,notifySound:false});
    await page.evaluate(()=>{window.__calendarReminderProof=[];window.electronAPI.calendar.onReminderFired(p=>window.__calendarReminderProof.push(p))});
    const now=Date.now(),rem={id:'accept-reminder',uid:'accept-reminder',calendarId:primary,title:'隔离验收提醒',start:now+4000,end:now+64000,allDay:false,timeZone:'UTC',status:'confirmed',transparency:'opaque',reminders:[{minutes:0,method:'notification'}],createdAt:now,updatedAt:now};
    await api('mutate',{type:'create',event:rem},{});await showMode('rss','.rss-mode-shell');
    await page.waitForFunction(()=>window.__calendarReminderProof?.some(p=>p.eventId==='accept-reminder'),{},{timeout:15000});
    ok('background reminder fires while calendar is hidden',true);
    await app.evaluate(({powerMonitor})=>powerMonitor.emit('resume'));await page.waitForTimeout(300);
    ok('resume handler does not redeliver the reminder',await page.evaluate(()=>window.__calendarReminderProof.filter(p=>p.eventId==='accept-reminder').length)===1);
    const persisted=(await events()).map(e=>[e.id,e.title,e.start,e.end]);await app.close();app=null;page=null;await launch();root=page.locator('[data-testid=ready-calendar]');
    ok('process restart preserves real SQLite records',JSON.stringify((await events()).map(e=>[e.id,e.title,e.start,e.end]))===JSON.stringify(persisted));
    const countRows=require('node:child_process').spawnSync(require('electron'),['-e',`const DB=require('better-sqlite3');const db=new DB(process.argv[1],{readonly:true});console.log(db.prepare("SELECT count(*) n FROM calendar_reminder_deliveries WHERE event_id='accept-reminder'").get().n);db.close()`,path.join(profile,'ready.db')],{env:{...process.env,ELECTRON_RUN_AS_NODE:'1'},encoding:'utf8'});
    ok('reminder delivery remains once after restart',countRows.status===0&&countRows.stdout.trim()==='1',countRows.stderr);
    await api('putPreferences',{notifications:false});
  }
  await page.screenshot({path:'outputs/calendar-union/acceptance-final.png'});ok('no renderer exceptions',errors.length===0,errors.join('\n'));
 }catch(error){if(page)await page.screenshot({path:'outputs/calendar-union/failure.png'}).catch(()=>{});throw error}finally{try{fs.writeFileSync('outputs/calendar-union/electron-acceptance.json',JSON.stringify(results,null,2))}finally{if(browser)await browser.close();if(app)await app.close()}}
})().catch(e=>{console.error(e);process.exitCode=1});
