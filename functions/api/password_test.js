import { pwcheck } from './../../src/pw.js';
  
export async function onRequest(context) {
  const { searchParams } = new URL(context.request.url)
  let pw = searchParams.get('pw')

  var response_html = '<h3>Password Requirements</h3><ul>'
  var result = await pwcheck(pw)
  response_html += '<li>' + result + '</li>'

  if ( pw.length >= 12 ) {
    response_html += '<li style="color:#064e3b"><strong>Must</strong> be at least 12 characters long</li>'
  } else {
    response_html += '<li style="color:#7f1d1d"><strong>Must</strong> be at least 12 characters long</li>'
  }

  var hasNumber = /\d/
  //hasNumber.test("ABC33SDF");  // true
  //hasNumber.test("ABCSDF");  // false 
  if ( hasNumber.test(pw) ) {
    response_html += '<li style="color:#064e3b">Should contain a number</li>'
  } else {
    response_html += '<li style="color:#7f1d1d">Should contain a number</li>'
  }

  var hasSpecial = /[^a-zA-Z\d]/
  if ( hasSpecial.test(pw) ) {
    response_html += '<li style="color:#064e3b">Should contain a special character</li>'
  } else {
    response_html += '<li style="color:#7f1d1d">Should contain a special character</li>'
  }

  // Should not be compronised</li>'
  function SHA1(f){function $(f,$){return f<<$|f>>>32-$}function r(f){var $,r,o,e="";for($=0;$<=6;$+=2)r=f>>>4*$+4&15,o=f>>>4*$&15,e+=r.toString(16)+o.toString(16);return e}function o(f){var $,r,o="";for($=7;$>=0;$--)o+=(r=f>>>4*$&15).toString(16);return o}var e,_,t,a,C,h,x,n,c,d=Array(80),A=1732584193,u=4023233417,s=2562383102,i=271733878,g=3285377520,m=(f=function f($){$=$.replace(/\r\n/g,"\n");for(var r="",o=0;o<$.length;o++){var e=$.charCodeAt(o);e<128?r+=String.fromCharCode(e):e>127&&e<2048?(r+=String.fromCharCode(e>>6|192),r+=String.fromCharCode(63&e|128)):(r+=String.fromCharCode(e>>12|224),r+=String.fromCharCode(e>>6&63|128),r+=String.fromCharCode(63&e|128))}return r}(f)).length,p=[];for(_=0;_<m-3;_+=4)t=f.charCodeAt(_)<<24|f.charCodeAt(_+1)<<16|f.charCodeAt(_+2)<<8|f.charCodeAt(_+3),p.push(t);switch(m%4){case 0:_=2147483648;break;case 1:_=f.charCodeAt(m-1)<<24|8388608;break;case 2:_=f.charCodeAt(m-2)<<24|f.charCodeAt(m-1)<<16|32768;break;case 3:_=f.charCodeAt(m-3)<<24|f.charCodeAt(m-2)<<16|f.charCodeAt(m-1)<<8|128}for(p.push(_);p.length%16!=14;)p.push(0);for(p.push(m>>>29),p.push(m<<3&4294967295),e=0;e<p.length;e+=16){for(_=0;_<16;_++)d[_]=p[e+_];for(_=16;_<=79;_++)d[_]=$(d[_-3]^d[_-8]^d[_-14]^d[_-16],1);for(_=0,a=A,C=u,h=s,x=i,n=g;_<=19;_++)c=$(a,5)+(C&h|~C&x)+n+d[_]+1518500249&4294967295,n=x,x=h,h=$(C,30),C=a,a=c;for(_=20;_<=39;_++)c=$(a,5)+(C^h^x)+n+d[_]+1859775393&4294967295,n=x,x=h,h=$(C,30),C=a,a=c;for(_=40;_<=59;_++)c=$(a,5)+(C&h|C&x|h&x)+n+d[_]+2400959708&4294967295,n=x,x=h,h=$(C,30),C=a,a=c;for(_=60;_<=79;_++)c=$(a,5)+(C^h^x)+n+d[_]+3395469782&4294967295,n=x,x=h,h=$(C,30),C=a,a=c;A=A+a&4294967295,u=u+C&4294967295,s=s+h&4294967295,i=i+x&4294967295,g=g+n&4294967295}var c=o(A)+o(u)+o(s)+o(i)+o(g);return c.toLowerCase()}
  var pw_sha1 = SHA1(pw)
  var pw_sha1_f5 = pw_sha1.slice(0, 5)
  var pw_sha1_l35 = pw_sha1.slice(5, 40)
  //response_html += '<li>' + pw_sha1_f5 + ' : ' + pw_sha1_l35 + '</li>'
  try {
    var compromised = 0
    await fetch('https://api.pwnedpasswords.com/range/' + pw_sha1_f5)
    .then((response) => response.text())
    .then((text) => {
      //response_html += '<li>' + text + '</li>'
      var inputArray = text.split('\n')
      for (var i = 0; i < inputArray.length; i++) {
        let line_f35 = inputArray[i].slice(0, 35)
        let line_ln = inputArray[i].substring(36)
        //response_html += '<li>' + i + ' : ' + line_f35 + ' : ' + line_ln + '</li>'
        if ( line_f35 == pw_sha1_l35.toUpperCase() ) {
          compromised = parseInt(line_ln)
        }
      }
    })

    if ( compromised > 0 ) {
      response_html += '<li style="color:#7f1d1d">Has been compromised ' + Intl.NumberFormat().format(compromised) + ' times</li>'
    } else {
      response_html += '<li style="color:#064e3b">Should not be compromised</li>'
    }
  } catch (err) {
      response_html += '<li>' + err + '</li>'
  }

  response_html += '</ul>'
  return new Response(response_html)
}
