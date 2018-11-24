const Discord = require("discord.js");
const client = new Discord.Client();
client.on('message', msg => {
   if(msg.content === "-السعودية") {
var embed20 = new Discord.RichEmbed()
.setTitle("🇸🇦 🕌 الاذان في السعودية 🕌 🇸🇦")
.setImage("https://cdn.discordapp.com/attachments/499383925924429837/502484545556316174/unknown.png")
msg.channel.sendEmbed(embed20).then(SA => {
   SA.react('🇸🇦').then(() => SA.react('🇸🇦'))    
})
}                      
 });

client.on('message', msg => {
   if(msg.content === "-مصر") {
var embed20 = new Discord.RichEmbed()
.setTitle("🇪🇬 🕌 الاذان في مصر 🕌 🇪🇬")
.setImage("https://cdn.discordapp.com/attachments/501948394286350356/502486345537683456/unknown.png")
msg.channel.sendEmbed(embed20).then(M => {
M.react('🇪🇬').then(() => M.react('🇪🇬'))
})
   }
 });


client.on('message', msg => {
   if(msg.content === "-العراق") {
var embed20 = new Discord.RichEmbed()
.setTitle("🇮🇶 🕌 الاذان في العراق 🕌 🇮🇶")
.setImage("https://cdn.discordapp.com/attachments/499383925924429837/502494601525985280/unknown.png")
msg.channel.sendEmbed(embed20).then(I => {
I.react('🇮🇶').then(() => I.react('🇮🇶'))
})
                                    }
 });
client.on('message', msg => {
   if(msg.content === "-المغرب") {
var embed20 = new Discord.RichEmbed()
.setTitle("🇲🇦 🕌 الاذان في المغرب 🕌🇲🇦 ")
.setImage("https://cdn.discordapp.com/attachments/499383925924429837/502494027375968266/unknown.png")
msg.channel.sendEmbed(embed20).then(A => {
A.react('🇲🇦').then(() => A.react('🇲🇦'))
})   
}
 });

client.on('message', msg => {
   if(msg.content === "-الجزائر") {
var embed20 = new Discord.RichEmbed()
.setTitle("🇩🇿 🕌 الاذان في الجزائر 🕌 🇩🇿")
.setImage("https://cdn.discordapp.com/attachments/502487711249203240/503300078295973900/unknown.png")
msg.channel.sendEmbed(embed20).then(D => {
D.react('🇩🇿').then(() => D.react('🇩🇿'))
})   
}
 });

client.on('message', msg => {
   if(msg.content === "-سوريا") {
var embed20 = new Discord.RichEmbed()
.setTitle("🇸🇾 🕌 الاذان في سوريا 🕌 🇸🇾")
.setImage("https://cdn.discordapp.com/attachments/499383925924429837/502495763549388800/unknown.png")
msg.channel.sendEmbed(embed20).then(S => {
S.react('🇸🇾').then(() => S.react('🇸🇾'))
})   
}
 });

client.on('message', msg => {
   if(msg.content === "-الأردن") {
var embed20 = new Discord.RichEmbed()
.setTitle("🇯🇴 🕌 الاذان في الأردن 🕌 🇯🇴")
.setImage("https://cdn.discordapp.com/attachments/499383925924429837/502496095570624533/unknown.png")
msg.channel.sendEmbed(embed20).then(J => {
J.react('🇯🇴').then(() => J.react('🇯🇴'))
})
   }
 });

client.on('message', msg => {
   if(msg.content === "-تونس") {
var embed20 = new Discord.RichEmbed()
.setTitle("🇹🇳 🕌 الاذان في تونس 🕌 🇹🇳")
.setImage("https://cdn.discordapp.com/attachments/499383925924429837/502496873073082394/unknown.png")
msg.channel.sendEmbed(embed20).then(T => {
T.react('🇹🇳').then(() => T.react('🇹🇳'))
})   
}
 });

client.on('message', msg => {
   if(msg.content === "-فلسطين") {
var embed20 = new Discord.RichEmbed()
.setTitle("🇵🇸 🕌 الاذان في فلسطين 🕌 🇵🇸")
.setImage("https://cdn.discordapp.com/attachments/499383925924429837/502496873073082394/unknown.png")
msg.channel.sendEmbed(embed20).then(P => {
P.react('🇵🇸').then(() => P.react('🇵🇸'))
})   
}
 });

client.on('message', msg => {
   if(msg.content === "-قطر") {
var embed20 = new Discord.RichEmbed()
.setTitle("🇶🇦 🕌 الاذان في قطر 🕌 🇶🇦")
.setImage("https://cdn.discordapp.com/attachments/499383925924429837/502497346207219742/unknown.png")
msg.channel.sendEmbed(embed20).then(Q => {
Q.react('🇶🇦').then(() => Q.react('🇶🇦'))
})   
   }
 });

client.on('message', msg => {
   if(msg.content === "-البحرين") {
var embed20 = new Discord.RichEmbed()
.setTitle("🇧🇭 🕌 الاذان في البحرين 🕌 🇧🇭")
.setImage("https://cdn.discordapp.com/attachments/499383925924429837/502497608284241940/unknown.png")
msg.channel.sendEmbed(embed20).then(B => {
B.react('🇧🇭').then(() => B.react('🇧🇭'))
})   
   }
                                                
                                    
 });
