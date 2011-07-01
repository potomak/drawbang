script = ""

script << "tput clear\n"

(0..15).each do |x|
  (0..15).each do |y|
    script << "tput cup #{x} #{y}\n"
    script << "tput setab #{(x+y)%8}\n"
    script << "echo ' '\n"
  end
end

system script

while true do
end