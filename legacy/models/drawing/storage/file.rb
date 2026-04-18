module Storage
  module File
    def self.included(base) # :nodoc:
      base.extend ClassMethods
    end
  
    module ClassMethods
      # save_file
      def save_file(filename, request_host, content)
        # save image
        ::File.open(::File.join(DRAWINGS_PATH, filename), "w") do |file|
          file << content
        end

        "http://#{request_host}/images/drawings/#{filename}"
      end
      
      # delete_file
      def delete_file(filename)
        ::File.delete(::File.join(DRAWINGS_PATH, filename))
      end
    end
  end
end