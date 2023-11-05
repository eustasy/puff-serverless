import { password_requirements } from './../../src/passwords.js';

const getMethods = (obj) => {
  let properties = new Set()
  let currentObj = obj
  do {
    Object.getOwnPropertyNames(currentObj).map(item => properties.add(item))
  } while ((currentObj = Object.getPrototypeOf(currentObj)))
  return [...properties.keys()].filter(item => typeof obj[item] === 'function')
}

export async function onRequest(context) {
  //const formdata = getMethods(context.request)
  let input = await context.request.formData();
  let pretty = JSON.stringify([...input], null, 2);
  //const formdata = await context.request.formData()
  //let pw = formdata.get('pw')
  //let response_html = await password_requirements(pw)
  return new Response(pretty)
}
