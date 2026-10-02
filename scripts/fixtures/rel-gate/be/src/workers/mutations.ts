// Fixture del check-rel-failure-classes (auto-test del escáner, M8c): cada emisor esconde un código NUEVO o una
// construcción que el escáner no puede leer. El check exige que TODOS se detecten (código sin regla o sin resolver).
async function branchAssignment(scheduler: any, id: string, ex: string, x: boolean) {
  let why = 'videogen_paid_maybe_new: el envío pudo haberse cobrado';
  if (x) why = 'lease_expired';
  await scheduler.failItem(id, ex, why, true);
}

async function ternaryTemplate(scheduler: any, id: string, ex: string, x: boolean) {
  const m = x ? 'lease_expired' : `tpl_new_code_be: ${x}`;
  await scheduler.failItem(id, ex, m, true);
}

async function helperCall(scheduler: any, id: string, ex: string, helper: any) {
  await scheduler.failItem(id, ex, helper.build('x'), true);
}

async function parameterOnly(scheduler: any, id: string, ex: string, p: string) {
  await scheduler.failItem(id, ex, p, true);
}

async function partiallyDynamic(scheduler: any, id: string, ex: string, err: Error) {
  let msg = 'unexpected_error: x';
  if (err) msg = err.message;
  await scheduler.failItem(id, ex, msg, true);
}
